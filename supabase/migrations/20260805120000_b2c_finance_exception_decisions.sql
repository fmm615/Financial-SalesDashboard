-- A Finance exception is an explicit, local inclusion decision for a succeeded
-- B2C provider payment whose source metadata is incomplete. It never changes
-- the Stripe source row or provider, and decisions are append-only.
create table public.b2c_payment_finance_exception_decisions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id),
  decision text not null check (decision in ('include', 'revoke')),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  confirmed_provider_transaction boolean not null,
  confirmed_no_known_duplicate boolean not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_payment_finance_exception_decisions_latest_idx
  on public.b2c_payment_finance_exception_decisions (payment_id, created_at desc, id desc);

create trigger audit_b2c_payment_finance_exception_decisions
  after insert on public.b2c_payment_finance_exception_decisions
  for each row execute procedure public.write_audit_event();

alter table public.b2c_payment_finance_exception_decisions enable row level security;

create policy approved_read on public.b2c_payment_finance_exception_decisions
  for select to authenticated using (public.is_approved_user());

create policy admin_insert on public.b2c_payment_finance_exception_decisions
  for insert to authenticated with check (public.is_admin());

revoke all on public.b2c_payment_finance_exception_decisions from anon;
grant select, insert on public.b2c_payment_finance_exception_decisions to authenticated;

create function public.include_b2c_payment_with_finance_exception(
  p_payment_id uuid,
  p_reason text,
  p_confirmed_provider_transaction boolean,
  p_confirmed_no_known_duplicate boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  local_override public.b2c_payment_local_overrides%rowtype;
  effective_category_code text;
  effective_amount_usd numeric(20, 6);
  effective_occurred_on date;
  prior_decision text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can include a B2C payment by Finance exception';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A Finance exception reason must be between 3 and 1000 characters';
  end if;
  if p_confirmed_provider_transaction is not true or p_confirmed_no_known_duplicate is not true then
    raise exception 'Confirm the provider transaction and duplicate review before including this payment';
  end if;

  select * into target_payment
  from public.b2c_payments
  where id = p_payment_id
  for update;
  if not found then
    raise exception 'The B2C payment is unavailable';
  end if;
  if target_payment.payment_status <> 'succeeded' then
    raise exception 'Only a succeeded provider payment can be included by Finance exception';
  end if;
  if target_payment.provider_transaction_id is null then
    raise exception 'A Finance exception requires the exact provider transaction ID';
  end if;
  if (select count(*) from public.b2c_payments where provider_transaction_id = target_payment.provider_transaction_id) <> 1 then
    raise exception 'The provider transaction ID is not unique locally';
  end if;
  if exists (
    select 1 from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and status = 'open'
      and flag_type = 'possible_duplicate'
  ) then
    raise exception 'Resolve the possible duplicate before using a Finance exception';
  end if;
  if exists (
    select 1 from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and status = 'open'
      and flag_type = 'needs_follow_up'
      and reason !~* 'missing a valid customer email'
  ) then
    raise exception 'This payment has another unresolved source issue that cannot be bypassed';
  end if;

  select * into local_override
  from public.b2c_payment_local_overrides
  where payment_id = p_payment_id;
  effective_category_code := coalesce(local_override.category_code, target_payment.category_code);
  effective_amount_usd := coalesce(local_override.local_amount_usd, target_payment.amount_usd);
  effective_occurred_on := coalesce(local_override.local_occurred_on, target_payment.occurred_on);
  if effective_category_code is null or lower(trim(effective_category_code)) = 'unmapped' then
    raise exception 'Save a verified local PLAYBOOK category before using a Finance exception';
  end if;
  if effective_amount_usd is null or effective_amount_usd <= 0 or effective_occurred_on is null then
    raise exception 'Save a verified local amount and business date before using a Finance exception';
  end if;

  select decision into prior_decision
  from public.b2c_payment_finance_exception_decisions
  where payment_id = p_payment_id
  order by created_at desc, id desc
  limit 1;

  insert into public.b2c_payment_finance_exception_decisions (
    payment_id, decision, reason, confirmed_provider_transaction,
    confirmed_no_known_duplicate, created_by
  ) values (
    p_payment_id, 'include', trim(p_reason), true, true, auth.uid()
  );

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value,
    reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    jsonb_build_object('finance_exception_decision', coalesce(prior_decision, 'none')),
    jsonb_build_object(
      'finance_exception_decision', 'include',
      'provider_transaction_id', target_payment.provider_transaction_id,
      'category_code', effective_category_code,
      'amount_usd', effective_amount_usd,
      'occurred_on', effective_occurred_on,
      'missing_source_fields_remain_visible', true
    ),
    trim(p_reason), effective_occurred_on
  );
end;
$$;

revoke all on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) from public;
grant execute on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) to authenticated;
