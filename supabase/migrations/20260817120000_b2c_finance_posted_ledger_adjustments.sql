
-- Posted Payment Tracker payments remain immutable. Finance amount and reporting-
-- date amendments are represented by signed, linked ledger entries so every
-- reporting period can be rebuilt without rewriting the original payment.

create table public.b2c_finance_ledger_adjustments (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id) on delete restrict,
  finance_row_id uuid not null references public.b2c_finance_staging_rows(id) on delete restrict,
  adjustment_request_id uuid not null,
  entry_index smallint not null check (entry_index in (1, 2)),
  adjustment_kind text not null check (adjustment_kind in (
    'amount_correction',
    'date_reclassification',
    'amount_and_date_correction'
  )),
  amount_delta_usd numeric(20, 6) not null check (amount_delta_usd <> 0),
  occurred_on date not null,
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  constraint b2c_finance_ledger_adjustments_finite_amount_check
    check (amount_delta_usd not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  constraint b2c_finance_ledger_adjustments_finite_occurred_on_check
    check (occurred_on not in ('infinity'::date, '-infinity'::date)),
  unique (payment_id, adjustment_request_id, entry_index)
);

create index b2c_finance_ledger_adjustments_payment_created_idx
  on public.b2c_finance_ledger_adjustments (payment_id, created_at, adjustment_request_id, entry_index);

create or replace function public.prevent_b2c_finance_ledger_adjustment_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'B2C Finance ledger adjustments are append-only';
end;
$$;

create trigger prevent_b2c_finance_ledger_adjustment_mutation
  before update or delete on public.b2c_finance_ledger_adjustments
  for each row execute procedure public.prevent_b2c_finance_ledger_adjustment_mutation();

create trigger audit_b2c_finance_ledger_adjustments
  after insert or update or delete on public.b2c_finance_ledger_adjustments
  for each row execute procedure public.write_audit_event();

alter table public.b2c_finance_ledger_adjustments enable row level security;

create policy admin_read on public.b2c_finance_ledger_adjustments
  for select to authenticated using (public.is_admin());

revoke all on public.b2c_finance_ledger_adjustments from public, anon, authenticated;
grant select on public.b2c_finance_ledger_adjustments to authenticated;

create or replace function public.apply_b2c_finance_posted_adjustment(
  p_finance_row_id uuid,
  p_occurred_on date,
  p_amount_usd numeric,
  p_customer_name text,
  p_category_raw text,
  p_adjustment_request_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_post public.b2c_finance_ledger_posts%rowtype;
  target_payment public.b2c_payments%rowtype;
  source_is_complete boolean := false;
  effective_balance_count integer := 0;
  current_occurred_on date;
  current_amount_usd numeric(20, 6);
  corrected_occurred_on date;
  corrected_amount_usd numeric(20, 6);
  adjustment_kind text;
  inserted_entries integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can adjust a posted B2C Finance payment';
  end if;
  if p_adjustment_request_id is null then
    raise exception 'Start the posted B2C Finance adjustment again';
  end if;

  -- Serialize every amendment for one posted source row. This also makes two
  -- simultaneous retries with one request ID converge on the first result.
  select posts.* into target_post
  from public.b2c_finance_ledger_posts posts
  where posts.finance_row_id = p_finance_row_id
  for update;

  if not found then
    raise exception 'The posted B2C Finance payment is unavailable';
  end if;

  select payments.* into target_payment
  from public.b2c_payments payments
  where payments.id = target_post.payment_id
  for update;

  if not found
    or target_payment.source_system <> 'finance_tracker'
    or target_payment.payment_status <> 'succeeded'
    or target_payment.original_currency <> 'USD'
    or target_payment.amount_usd is null
    or target_payment.amount_usd in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or target_payment.occurred_on in ('infinity'::date, '-infinity'::date)
    or target_payment.reconciliation_source is distinct from 'payment_tracker'
    or target_payment.source_metadata ->> 'finance_row_id' is distinct from p_finance_row_id::text then
    raise exception 'Only a complete USD Payment Tracker ledger payment can be adjusted';
  end if;

  select exists (
    select 1
    from public.b2c_finance_effective_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where rows.id = target_post.finance_row_id
      and imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and rows.effective_quality = 'valid'
      and rows.occurred_on is not null
      and rows.occurred_on not in ('infinity'::date, '-infinity'::date)
      and rows.amount_usd not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      and rows.amount_usd > 0
  ) into source_is_complete;

  if not source_is_complete then
    raise exception 'Only a complete USD Payment Tracker ledger payment can be adjusted';
  end if;

  if exists (
    select 1
    from public.b2c_finance_ledger_adjustments adjustments
    where adjustments.payment_id = target_post.payment_id
      and adjustments.adjustment_request_id = p_adjustment_request_id
  ) then
    return 0;
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A posted B2C Finance adjustment reason must be between 3 and 1000 characters';
  end if;
  if p_customer_name is not null or p_category_raw is not null then
    raise exception 'Posted B2C Finance ledger adjustments can only change amount or reporting Date';
  end if;
  if p_occurred_on is null and p_amount_usd is null then
    raise exception 'Enter a verified amount or reporting Date';
  end if;
  if p_amount_usd in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'A corrected B2C Finance amount must be finite';
  end if;
  if p_occurred_on in ('infinity'::date, '-infinity'::date) then
    raise exception 'A corrected B2C Finance reporting Date must be finite';
  end if;
  if p_amount_usd is not null and p_amount_usd <> round(p_amount_usd, 6) then
    raise exception 'A corrected B2C Finance amount can have at most 6 decimal places';
  end if;

  with ledger_entries as (
    select target_payment.occurred_on as business_date,
           target_payment.amount_usd::numeric as signed_amount_usd
    union all
    select adjustments.occurred_on,
           adjustments.amount_delta_usd::numeric
    from public.b2c_finance_ledger_adjustments adjustments
    where adjustments.payment_id = target_post.payment_id
      and adjustments.finance_row_id = target_post.finance_row_id
  ), effective_balances as (
    select business_date, sum(signed_amount_usd)::numeric(20, 6) as amount_usd
    from ledger_entries
    group by business_date
    having sum(signed_amount_usd) <> 0
  )
  select count(*)::integer, min(business_date), min(amount_usd)
  into effective_balance_count, current_occurred_on, current_amount_usd
  from effective_balances;

  if effective_balance_count <> 1
    or current_amount_usd is null
    or current_amount_usd in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or current_occurred_on in ('infinity'::date, '-infinity'::date)
    or current_amount_usd <= 0 then
    raise exception 'The current posted B2C Finance balance needs review before another adjustment';
  end if;

  corrected_occurred_on := coalesce(p_occurred_on, current_occurred_on);
  corrected_amount_usd := coalesce(p_amount_usd, current_amount_usd)::numeric(20, 6);

  if corrected_amount_usd in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'A corrected B2C Finance amount must be finite';
  end if;
  if corrected_occurred_on in ('infinity'::date, '-infinity'::date) then
    raise exception 'A corrected B2C Finance reporting Date must be finite';
  end if;
  if corrected_amount_usd <= 0 then
    raise exception 'A corrected B2C Finance amount must be greater than zero';
  end if;
  if corrected_occurred_on is not distinct from current_occurred_on
    and corrected_amount_usd is not distinct from current_amount_usd then
    raise exception 'The submitted values do not change this posted B2C Finance payment';
  end if;

  if corrected_occurred_on = current_occurred_on then
    adjustment_kind := 'amount_correction';

    insert into public.b2c_finance_ledger_adjustments (
      payment_id, finance_row_id, adjustment_request_id, entry_index,
      adjustment_kind, amount_delta_usd, occurred_on, reason, created_by
    ) values (
      target_post.payment_id, target_post.finance_row_id, p_adjustment_request_id, 1,
      adjustment_kind, corrected_amount_usd - current_amount_usd,
      current_occurred_on, trim(p_reason), auth.uid()
    );
    inserted_entries := 1;
  else
    adjustment_kind := case
      when corrected_amount_usd = current_amount_usd then 'date_reclassification'
      else 'amount_and_date_correction'
    end;

    insert into public.b2c_finance_ledger_adjustments (
      payment_id, finance_row_id, adjustment_request_id, entry_index,
      adjustment_kind, amount_delta_usd, occurred_on, reason, created_by
    ) values
      (
        target_post.payment_id, target_post.finance_row_id, p_adjustment_request_id, 1,
        adjustment_kind, -current_amount_usd, current_occurred_on,
        trim(p_reason), auth.uid()
      ),
      (
        target_post.payment_id, target_post.finance_row_id, p_adjustment_request_id, 2,
        adjustment_kind, corrected_amount_usd, corrected_occurred_on,
        trim(p_reason), auth.uid()
      );
    inserted_entries := 2;
  end if;

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type,
    before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment',
    target_post.payment_id,
    case adjustment_kind
      when 'amount_correction' then 'amount'
      when 'date_reclassification' then 'date'
      else 'other'
    end,
    jsonb_build_object(
      'payment_id', target_post.payment_id,
      'finance_row_id', target_post.finance_row_id,
      'amount_usd', current_amount_usd,
      'occurred_on', current_occurred_on
    ),
    jsonb_build_object(
      'payment_id', target_post.payment_id,
      'finance_row_id', target_post.finance_row_id,
      'amount_usd', corrected_amount_usd,
      'occurred_on', corrected_occurred_on,
      'adjustment_request_id', p_adjustment_request_id
    ),
    trim(p_reason),
    corrected_occurred_on
  );

  return inserted_entries;
end;
$$;

-- This view deliberately exposes only linked signed Finance facts. It runs as
-- the view owner so an approved Viewer receives the same effective facts as an
-- Admin without gaining direct access to the Admin-only adjustment history.
create view public.b2c_finance_effective_ledger_entries
with (security_barrier = true)
as
select
  payments.id as payment_id,
  posts.finance_row_id,
  payments.id as ledger_entry_id,
  'original_payment'::text as entry_kind,
  null::uuid as adjustment_request_id,
  null::smallint as entry_index,
  null::text as adjustment_kind,
  payments.amount_usd,
  payments.occurred_on,
  payments.created_at
from public.b2c_payments payments
join public.b2c_finance_ledger_posts posts on posts.payment_id = payments.id
where payments.source_system = 'finance_tracker'
  and public.is_approved_user()
union all
select
  adjustments.payment_id,
  adjustments.finance_row_id,
  adjustments.id as ledger_entry_id,
  'adjustment'::text as entry_kind,
  adjustments.adjustment_request_id,
  adjustments.entry_index,
  adjustments.adjustment_kind,
  adjustments.amount_delta_usd as amount_usd,
  adjustments.occurred_on,
  adjustments.created_at
from public.b2c_finance_ledger_adjustments adjustments
where public.is_approved_user();

create or replace function public.get_b2c_finance_posted_adjustments()
returns table (
  id uuid,
  payment_id uuid,
  finance_row_id uuid,
  adjustment_request_id uuid,
  entry_index smallint,
  adjustment_kind text,
  amount_delta_usd numeric,
  occurred_on date,
  reason text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can view posted B2C Finance adjustments';
  end if;

  return query
  select
    adjustments.id,
    adjustments.payment_id,
    adjustments.finance_row_id,
    adjustments.adjustment_request_id,
    adjustments.entry_index,
    adjustments.adjustment_kind,
    adjustments.amount_delta_usd::numeric,
    adjustments.occurred_on,
    adjustments.reason,
    adjustments.created_by,
    adjustments.created_at
  from public.b2c_finance_ledger_adjustments adjustments
  order by adjustments.created_at desc,
           adjustments.adjustment_request_id,
           adjustments.entry_index;
end;
$$;

revoke all on function public.prevent_b2c_finance_ledger_adjustment_mutation() from public;
revoke all on function public.apply_b2c_finance_posted_adjustment(uuid, date, numeric, text, text, uuid, text) from public;
revoke all on function public.get_b2c_finance_posted_adjustments() from public;
grant execute on function public.apply_b2c_finance_posted_adjustment(uuid, date, numeric, text, text, uuid, text) to authenticated;
grant execute on function public.get_b2c_finance_posted_adjustments() to authenticated;

revoke all on public.b2c_finance_effective_ledger_entries from public, anon, authenticated;
grant select on public.b2c_finance_effective_ledger_entries to authenticated;


