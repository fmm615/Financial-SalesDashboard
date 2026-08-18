
-- Resolve staged Finance quality blockers only when a matching audited override
-- proves the missing or conflicting fact. Source workbook rows remain immutable.

alter table public.b2c_finance_row_overrides
  add column if not exists payment_method_raw text;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraints.conname
    from pg_constraint constraints
    where constraints.conrelid = 'public.b2c_finance_row_overrides'::regclass
      and constraints.contype = 'c'
      and pg_get_constraintdef(constraints.oid) like '%date_authority_confirmed_at%'
      and pg_get_constraintdef(constraints.oid) not like '%payment_method_raw%'
  loop
    execute format('alter table public.b2c_finance_row_overrides drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.b2c_finance_row_overrides
  drop constraint if exists b2c_finance_row_overrides_has_value_check;
alter table public.b2c_finance_row_overrides
  add constraint b2c_finance_row_overrides_has_value_check check (
    occurred_on is not null
    or amount_usd is not null
    or customer_name is not null
    or category_raw is not null
    or payment_method_raw is not null
    or date_authority_confirmed_at is not null
  );
alter table public.b2c_finance_row_overrides
  drop constraint if exists b2c_finance_row_overrides_payment_method_check;
alter table public.b2c_finance_row_overrides
  add constraint b2c_finance_row_overrides_payment_method_check
  check (payment_method_raw is null or char_length(trim(payment_method_raw)) between 1 and 100);

create or replace function public.b2c_finance_unresolved_quality_issues(
  p_quality_issues jsonb,
  p_override_occurred_on date,
  p_override_amount_usd numeric,
  p_override_customer_name text,
  p_override_payment_method text,
  p_date_authority_confirmed_at timestamptz
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(issues.issue order by issues.ordinality) filter (
      where not case issues.issue
        when 'unparseable_date' then p_override_occurred_on is not null
        when 'missing_amount' then p_override_amount_usd is not null and p_override_amount_usd > 0
        when 'invalid_amount' then p_override_amount_usd is not null and p_override_amount_usd > 0
        when 'missing_customer_name' then nullif(trim(p_override_customer_name), '') is not null
        when 'missing_payment_method' then nullif(trim(p_override_payment_method), '') is not null
        when 'declared_month_conflicts_with_date' then p_date_authority_confirmed_at is not null or p_override_occurred_on is not null
        when 'declared_year_conflicts_with_date' then p_date_authority_confirmed_at is not null or p_override_occurred_on is not null
        else false
      end
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements_text(coalesce(p_quality_issues, '[]'::jsonb)) with ordinality as issues(issue, ordinality);
$$;

create or replace view public.b2c_finance_effective_rows
with (security_invoker = true)
as
select
  rows.id,
  rows.import_id,
  rows.source_tab,
  rows.source_row_number,
  rows.reported_date_raw,
  rows.declared_month_raw,
  rows.declared_year_raw,
  rows.amount_usd_raw,
  rows.customer_name_raw,
  rows.customer_email_raw,
  rows.customer_phone_raw,
  rows.category_raw as source_category_raw,
  rows.membership_type_raw,
  coalesce(overrides.payment_method_raw, rows.payment_method_raw) as payment_method_raw,
  rows.payment_status_raw,
  rows.note_raw,
  rows.occurred_on as source_occurred_on,
  rows.amount_usd as source_amount_usd,
  rows.row_quality as source_row_quality,
  rows.quality_issues,
  overrides.occurred_on as override_occurred_on,
  overrides.amount_usd as override_amount_usd,
  overrides.customer_name as override_customer_name,
  overrides.category_raw as override_category_raw,
  overrides.date_authority_confirmed_at,
  coalesce(overrides.occurred_on, rows.occurred_on) as occurred_on,
  coalesce(overrides.amount_usd, rows.amount_usd) as amount_usd,
  coalesce(overrides.customer_name, rows.customer_name_raw) as customer_name,
  coalesce(overrides.category_raw, rows.category_raw) as category_raw,
  case
    when rows.row_quality = 'zero_value' then 'zero_value'::public.b2c_finance_row_quality
    when resolution.unresolved_quality_issues = '[]'::jsonb
      and coalesce(overrides.occurred_on, rows.occurred_on) is not null
      and coalesce(overrides.amount_usd, rows.amount_usd) > 0
      and nullif(trim(coalesce(overrides.customer_name, rows.customer_name_raw)), '') is not null
      and nullif(trim(coalesce(overrides.payment_method_raw, rows.payment_method_raw)), '') is not null
      then 'valid'::public.b2c_finance_row_quality
    when resolution.unresolved_quality_issues ? 'invalid_amount' then 'invalid'::public.b2c_finance_row_quality
    else 'needs_review'::public.b2c_finance_row_quality
  end as effective_quality,
  rows.customer_name_raw as source_customer_name_raw,
  rows.payment_method_raw as source_payment_method_raw,
  overrides.payment_method_raw as override_payment_method_raw,
  resolution.unresolved_quality_issues
from public.b2c_finance_staging_rows rows
left join public.b2c_finance_row_overrides overrides on overrides.finance_row_id = rows.id
cross join lateral (
  select public.b2c_finance_unresolved_quality_issues(
    rows.quality_issues,
    overrides.occurred_on,
    overrides.amount_usd,
    overrides.customer_name,
    overrides.payment_method_raw,
    overrides.date_authority_confirmed_at
  ) as unresolved_quality_issues
) resolution;

create or replace function public.apply_b2c_finance_row_resolution(
  p_finance_row_id uuid,
  p_occurred_on date,
  p_amount_usd numeric,
  p_customer_name text,
  p_category_raw text,
  p_payment_method_raw text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.b2c_finance_staging_rows%rowtype;
  prior_override public.b2c_finance_row_overrides%rowtype;
  effective_occurred_on date;
  effective_payment_method text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can correct a staged B2C Finance row';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A Finance correction reason must be between 3 and 1000 characters';
  end if;
  if p_occurred_on is null and p_amount_usd is null and p_customer_name is null
    and p_category_raw is null and p_payment_method_raw is null then
    raise exception 'Enter at least one verified Finance correction';
  end if;
  if p_payment_method_raw is not null and char_length(trim(p_payment_method_raw)) not between 1 and 100 then
    raise exception 'A corrected payment method must be between 1 and 100 characters';
  end if;

  if p_occurred_on is not null or p_amount_usd is not null or p_customer_name is not null or p_category_raw is not null then
    perform public.apply_b2c_finance_row_correction(
      p_finance_row_id, p_occurred_on, p_amount_usd, p_customer_name, p_category_raw, p_reason
    );
  end if;

  if p_payment_method_raw is null then
    return;
  end if;

  select * into source_row
  from public.b2c_finance_staging_rows
  where id = p_finance_row_id
  for update;
  if not found then
    raise exception 'The staged B2C Finance row is unavailable';
  end if;
  if exists (select 1 from public.b2c_finance_ledger_posts where finance_row_id = p_finance_row_id) then
    raise exception 'A posted B2C Finance row cannot be corrected here';
  end if;

  select * into prior_override
  from public.b2c_finance_row_overrides
  where finance_row_id = p_finance_row_id
  for update;

  effective_occurred_on := coalesce(prior_override.occurred_on, source_row.occurred_on);
  effective_payment_method := nullif(trim(p_payment_method_raw), '');
  if effective_occurred_on is null then
    raise exception 'Correct the Finance date before saving other values';
  end if;
  if effective_payment_method is not distinct from coalesce(prior_override.payment_method_raw, source_row.payment_method_raw) then
    raise exception 'The submitted payment method does not change this Finance row';
  end if;

  insert into public.b2c_finance_row_overrides (
    finance_row_id, payment_method_raw, created_by, updated_by
  ) values (
    p_finance_row_id, effective_payment_method, auth.uid(), auth.uid()
  ) on conflict (finance_row_id) do update set
    payment_method_raw = excluded.payment_method_raw,
    updated_by = auth.uid();

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_finance_row', p_finance_row_id, 'classification',
    jsonb_build_object('payment_method_raw', coalesce(prior_override.payment_method_raw, source_row.payment_method_raw)),
    jsonb_build_object('payment_method_raw', effective_payment_method),
    trim(p_reason), effective_occurred_on
  );
end;
$$;

revoke all on function public.b2c_finance_unresolved_quality_issues(jsonb, date, numeric, text, text, timestamptz) from public;
revoke all on function public.apply_b2c_finance_row_resolution(uuid, date, numeric, text, text, text, text) from public;
grant execute on function public.b2c_finance_unresolved_quality_issues(jsonb, date, numeric, text, text, timestamptz) to authenticated;
grant execute on function public.apply_b2c_finance_row_resolution(uuid, date, numeric, text, text, text, text) to authenticated;
revoke all on public.b2c_finance_effective_rows from public;
grant select on public.b2c_finance_effective_rows to authenticated;



