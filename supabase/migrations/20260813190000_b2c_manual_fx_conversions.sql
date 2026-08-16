-- Finance-approved B2C FX conversions are local PLAYBOOK evidence only.
-- They deliberately never update Stripe, Tap, or the immutable provider source rows.

alter table public.b2c_payments
  drop constraint if exists b2c_payments_tap_currency_reporting_check,
  add constraint b2c_payments_tap_currency_reporting_check
  check (
    source_system <> 'tap'
    or (
      original_currency = 'USD'
      and exchange_rate_to_usd is not null
      and amount_usd is not null
      and gross_amount_usd is not null
    )
    or (
      original_currency <> 'USD'
      and exchange_rate_to_usd is null
      and amount_usd is null
      and gross_amount_usd is null
    )
  ) not valid;

alter table public.b2c_refunds
  drop constraint if exists b2c_refunds_tap_currency_reporting_check,
  add constraint b2c_refunds_tap_currency_reporting_check
  check (
    source_system <> 'tap'
    or (
      original_currency = 'USD'
      and exchange_rate_to_usd is not null
      and amount_usd is not null
    )
    or (
      original_currency <> 'USD'
      and exchange_rate_to_usd is null
      and amount_usd is null
    )
  ) not valid;

create table public.b2c_payment_fx_conversions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id) on delete restrict,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency text not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  effective_on date not null,
  conversion_source text not null check (char_length(trim(conversion_source)) between 3 and 300),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_payment_fx_conversions_latest_idx
  on public.b2c_payment_fx_conversions (payment_id, created_at desc, id desc);

create trigger audit_b2c_payment_fx_conversions
  after insert on public.b2c_payment_fx_conversions
  for each row execute procedure public.write_audit_event();

alter table public.b2c_payment_fx_conversions enable row level security;
create policy approved_read on public.b2c_payment_fx_conversions
  for select to authenticated using (public.is_approved_user());
revoke all on public.b2c_payment_fx_conversions from anon;
-- Inserts are deliberately RPC-only. An authenticated Admin cannot spoof the
-- actor, source amount, or calculated USD amount with a direct table write.
revoke insert, update, delete on public.b2c_payment_fx_conversions from authenticated;
grant select on public.b2c_payment_fx_conversions to authenticated;

create table public.b2c_refund_fx_conversions (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.b2c_refunds(id) on delete restrict,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency text not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  effective_on date not null,
  conversion_source text not null check (char_length(trim(conversion_source)) between 3 and 300),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_refund_fx_conversions_latest_idx
  on public.b2c_refund_fx_conversions (refund_id, created_at desc, id desc);

create trigger audit_b2c_refund_fx_conversions
  after insert on public.b2c_refund_fx_conversions
  for each row execute procedure public.write_audit_event();

alter table public.b2c_refund_fx_conversions enable row level security;
create policy approved_read on public.b2c_refund_fx_conversions
  for select to authenticated using (public.is_approved_user());
revoke all on public.b2c_refund_fx_conversions from anon;
-- Inserts are deliberately RPC-only. The security-definer routine attributes
-- every conversion to auth.uid() and recalculates its USD amount server-side.
revoke insert, update, delete on public.b2c_refund_fx_conversions from authenticated;
grant select on public.b2c_refund_fx_conversions to authenticated;

-- Never allow a generic local correction to manufacture USD for a foreign
-- provider payment. FX must go through the append-only conversion workflow.
create or replace function public.prevent_b2c_foreign_local_usd_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  payment_currency text;
begin
  if new.local_amount_usd is null then
    return new;
  end if;
  select original_currency into payment_currency
  from public.b2c_payments where id = new.payment_id;
  if payment_currency is distinct from 'USD' then
    raise exception 'A foreign-currency payment requires a Finance-approved FX conversion; do not enter a local USD amount directly';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_b2c_foreign_local_usd_override on public.b2c_payment_local_overrides;
create trigger prevent_b2c_foreign_local_usd_override
  before insert or update of local_amount_usd on public.b2c_payment_local_overrides
  for each row execute procedure public.prevent_b2c_foreign_local_usd_override();

create or replace function public.record_b2c_payment_fx_conversion(
  p_payment_id uuid,
  p_exchange_rate_to_usd numeric(20, 10),
  p_conversion_source text,
  p_effective_on date,
  p_reason text
)
returns numeric(20, 6)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  prior_conversion public.b2c_payment_fx_conversions%rowtype;
  converted_amount numeric(20, 6);
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a B2C FX conversion';
  end if;
  if p_exchange_rate_to_usd is null or p_exchange_rate_to_usd <= 0 then
    raise exception 'Exchange rate to USD must be greater than zero';
  end if;
  if p_effective_on is null then
    raise exception 'A conversion effective date is required';
  end if;
  if char_length(trim(coalesce(p_conversion_source, ''))) not between 3 and 300 then
    raise exception 'A conversion source must be between 3 and 300 characters';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A conversion reason must be between 3 and 1000 characters';
  end if;

  select * into target_payment from public.b2c_payments where id = p_payment_id for update;
  if not found then raise exception 'The B2C payment is unavailable'; end if;
  if target_payment.original_currency = 'USD' then
    raise exception 'This payment is already a USD source payment and does not require an FX conversion';
  end if;
  if target_payment.payment_status <> 'succeeded' then
    raise exception 'Only a succeeded provider payment can receive a Finance FX conversion';
  end if;

  select * into prior_conversion from public.b2c_payment_fx_conversions
  where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  converted_amount := round(target_payment.original_amount * p_exchange_rate_to_usd, 6);

  insert into public.b2c_payment_fx_conversions (
    payment_id, original_amount, original_currency, exchange_rate_to_usd,
    amount_usd, effective_on, conversion_source, reason, created_by
  ) values (
    p_payment_id, target_payment.original_amount, target_payment.original_currency,
    p_exchange_rate_to_usd, converted_amount, p_effective_on,
    trim(p_conversion_source), trim(p_reason), auth.uid()
  );

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    case when prior_conversion.id is null then null else jsonb_build_object('amount_usd', prior_conversion.amount_usd, 'exchange_rate_to_usd', prior_conversion.exchange_rate_to_usd, 'conversion_source', prior_conversion.conversion_source) end,
    jsonb_build_object('original_amount', target_payment.original_amount, 'original_currency', target_payment.original_currency, 'amount_usd', converted_amount, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'conversion_source', trim(p_conversion_source)),
    trim(p_reason), p_effective_on
  );

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', trim(p_reason) from public.review_flags
  where source_area = 'b2c_payment' and source_record_id = p_payment_id
    and flag_type = 'needs_fx_review' and status = 'open'
  on conflict (flag_id) do nothing;
  return converted_amount;
end;
$$;

create or replace function public.record_b2c_refund_fx_conversion(
  p_refund_id uuid,
  p_exchange_rate_to_usd numeric(20, 10),
  p_conversion_source text,
  p_effective_on date,
  p_reason text
)
returns numeric(20, 6)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_refund public.b2c_refunds%rowtype;
  original_payment public.b2c_payments%rowtype;
  prior_conversion public.b2c_refund_fx_conversions%rowtype;
  payment_amount_usd numeric(20, 6);
  other_refunds_usd numeric(20, 6);
  converted_amount numeric(20, 6);
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can record a B2C refund FX conversion'; end if;
  if p_exchange_rate_to_usd is null or p_exchange_rate_to_usd <= 0 then raise exception 'Exchange rate to USD must be greater than zero'; end if;
  if p_effective_on is null then raise exception 'A conversion effective date is required'; end if;
  if char_length(trim(coalesce(p_conversion_source, ''))) not between 3 and 300 then raise exception 'A conversion source must be between 3 and 300 characters'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'A conversion reason must be between 3 and 1000 characters'; end if;

  select * into target_refund from public.b2c_refunds where id = p_refund_id for update;
  if not found then raise exception 'The B2C refund is unavailable'; end if;
  if target_refund.original_currency = 'USD' then raise exception 'This refund is already a USD source refund and does not require an FX conversion'; end if;
  select * into original_payment from public.b2c_payments where id = target_refund.payment_id for update;
  select case
    when original_payment.original_currency <> 'USD' then payment_conversion.amount_usd
    else coalesce(local_override.local_amount_usd, original_payment.amount_usd)
  end
    into payment_amount_usd
  from public.b2c_payments ignored
  left join public.b2c_payment_local_overrides local_override on local_override.payment_id = ignored.id
  left join lateral (select amount_usd from public.b2c_payment_fx_conversions where payment_id = ignored.id order by created_at desc, id desc limit 1) payment_conversion on true
  where ignored.id = original_payment.id;
  if payment_amount_usd is null then raise exception 'Record the original payment FX conversion before converting this refund'; end if;

  converted_amount := round(target_refund.original_amount * p_exchange_rate_to_usd, 6);
  select coalesce(sum(coalesce(refund_conversion.amount_usd, other_refund.amount_usd)), 0) into other_refunds_usd
  from public.b2c_refunds other_refund
  left join lateral (select amount_usd from public.b2c_refund_fx_conversions where refund_id = other_refund.id order by created_at desc, id desc limit 1) refund_conversion on true
  where other_refund.payment_id = target_refund.payment_id and other_refund.id <> p_refund_id;
  if other_refunds_usd + converted_amount > payment_amount_usd then raise exception 'Refund total cannot exceed the converted original payment amount'; end if;

  select * into prior_conversion from public.b2c_refund_fx_conversions where refund_id = p_refund_id order by created_at desc, id desc limit 1;
  insert into public.b2c_refund_fx_conversions (refund_id, original_amount, original_currency, exchange_rate_to_usd, amount_usd, effective_on, conversion_source, reason, created_by)
  values (p_refund_id, target_refund.original_amount, target_refund.original_currency, p_exchange_rate_to_usd, converted_amount, p_effective_on, trim(p_conversion_source), trim(p_reason), auth.uid());
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
  values ('b2c_refund', p_refund_id, 'other', case when prior_conversion.id is null then null else jsonb_build_object('amount_usd', prior_conversion.amount_usd, 'exchange_rate_to_usd', prior_conversion.exchange_rate_to_usd, 'conversion_source', prior_conversion.conversion_source) end, jsonb_build_object('original_amount', target_refund.original_amount, 'original_currency', target_refund.original_currency, 'amount_usd', converted_amount, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'conversion_source', trim(p_conversion_source)), trim(p_reason), p_effective_on);
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', trim(p_reason) from public.review_flags where source_area = 'b2c_refund' and source_record_id = p_refund_id and flag_type = 'needs_fx_review' and status = 'open' on conflict (flag_id) do nothing;
  return converted_amount;
end;
$$;

-- Finance exceptions may bypass only missing source metadata; they may never
-- bypass FX. The effective USD amount may be a verified USD overlay or the
-- latest append-only Finance conversion for this source payment.
create or replace function public.include_b2c_payment_with_finance_exception(
  p_payment_id uuid, p_reason text, p_confirmed_provider_transaction boolean, p_confirmed_no_known_duplicate boolean
)
returns void language plpgsql security definer set search_path = public as $$
declare target_payment public.b2c_payments%rowtype; local_override public.b2c_payment_local_overrides%rowtype; fx_conversion public.b2c_payment_fx_conversions%rowtype; effective_category_code text; effective_amount_usd numeric(20, 6); effective_occurred_on date; prior_decision text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can include a B2C payment by Finance exception'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'A Finance exception reason must be between 3 and 1000 characters'; end if;
  if p_confirmed_provider_transaction is not true or p_confirmed_no_known_duplicate is not true then raise exception 'Confirm the provider transaction and duplicate review before including this payment'; end if;
  select * into target_payment from public.b2c_payments where id = p_payment_id for update;
  if not found then raise exception 'The B2C payment is unavailable'; end if;
  if target_payment.payment_status <> 'succeeded' then raise exception 'Only a succeeded provider payment can be included by Finance exception'; end if;
  if target_payment.provider_transaction_id is null or (select count(*) from public.b2c_payments where provider_transaction_id = target_payment.provider_transaction_id) <> 1 then raise exception 'A Finance exception requires the exact unique provider transaction ID'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'possible_duplicate') then raise exception 'Resolve the possible duplicate before using a Finance exception'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'needs_follow_up' and reason !~* 'missing a valid customer email') then raise exception 'This payment has another unresolved source issue that cannot be bypassed'; end if;
  select * into local_override from public.b2c_payment_local_overrides where payment_id = p_payment_id;
  select * into fx_conversion from public.b2c_payment_fx_conversions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  effective_category_code := coalesce(local_override.category_code, target_payment.category_code);
  -- A foreign source can use only its append-only Finance conversion. This
  -- deliberately ignores any historical generic local USD overlay.
  effective_amount_usd := case
    when target_payment.original_currency <> 'USD' then fx_conversion.amount_usd
    else coalesce(local_override.local_amount_usd, target_payment.amount_usd)
  end;
  effective_occurred_on := coalesce(local_override.local_occurred_on, target_payment.occurred_on);
  if effective_category_code is null or lower(trim(effective_category_code)) = 'unmapped' then raise exception 'Save a verified local PLAYBOOK category before using a Finance exception'; end if;
  if effective_amount_usd is null or effective_amount_usd <= 0 or effective_occurred_on is null then raise exception 'Record a Finance-approved USD conversion and verified business date before using a Finance exception'; end if;
  select decision into prior_decision from public.b2c_payment_finance_exception_decisions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  insert into public.b2c_payment_finance_exception_decisions (payment_id, decision, reason, confirmed_provider_transaction, confirmed_no_known_duplicate, created_by) values (p_payment_id, 'include', trim(p_reason), true, true, auth.uid());
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2c_payment', p_payment_id, 'other', jsonb_build_object('finance_exception_decision', coalesce(prior_decision, 'none')), jsonb_build_object('finance_exception_decision', 'include', 'provider_transaction_id', target_payment.provider_transaction_id, 'category_code', effective_category_code, 'amount_usd', effective_amount_usd, 'occurred_on', effective_occurred_on, 'missing_source_fields_remain_visible', true), trim(p_reason), effective_occurred_on);
end;
$$;

revoke all on function public.record_b2c_payment_fx_conversion(uuid, numeric, text, date, text) from public;
grant execute on function public.record_b2c_payment_fx_conversion(uuid, numeric, text, date, text) to authenticated;
revoke all on function public.record_b2c_refund_fx_conversion(uuid, numeric, text, date, text) from public;
grant execute on function public.record_b2c_refund_fx_conversion(uuid, numeric, text, date, text) to authenticated;
revoke all on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) from public;
grant execute on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) to authenticated;
