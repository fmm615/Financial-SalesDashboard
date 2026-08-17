-- Finance source workbooks are immutable evidence. This migration records
-- verified corrections as an audited local overlay and exposes effective values
-- for later posting without rewriting any uploaded source row.

alter table public.financial_corrections
  drop constraint if exists financial_corrections_target_area_check;

alter table public.financial_corrections
  add constraint financial_corrections_target_area_check
  check (target_area in ('b2c_payment', 'b2c_finance_row', 'b2b_booking', 'b2b_recognised_sale', 'expense'));

create table public.b2c_finance_row_overrides (
  id uuid primary key default gen_random_uuid(),
  finance_row_id uuid not null unique references public.b2c_finance_staging_rows(id),
  occurred_on date,
  amount_usd numeric(20, 6),
  customer_name text,
  category_raw text,
  date_authority_confirmed_at timestamptz,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    occurred_on is not null
    or amount_usd is not null
    or customer_name is not null
    or category_raw is not null
    or date_authority_confirmed_at is not null
  ),
  check (amount_usd is null or amount_usd > 0),
  check (customer_name is null or char_length(trim(customer_name)) between 1 and 200),
  check (category_raw is null or char_length(trim(category_raw)) between 1 and 200)
);

create index b2c_finance_row_overrides_finance_row_idx
  on public.b2c_finance_row_overrides (finance_row_id);

create or replace function public.assign_b2c_finance_row_override_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can correct staged B2C Finance rows';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  elsif new.created_by is distinct from old.created_by then
    raise exception 'B2C Finance correction actor cannot be changed';
  end if;

  new.updated_by := auth.uid();
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create trigger assign_b2c_finance_row_override_actor
  before insert or update on public.b2c_finance_row_overrides
  for each row execute procedure public.assign_b2c_finance_row_override_actor();

create trigger audit_b2c_finance_row_overrides
  after insert or update on public.b2c_finance_row_overrides
  for each row execute procedure public.write_audit_event();

alter table public.b2c_finance_row_overrides enable row level security;

create policy admin_read on public.b2c_finance_row_overrides
  for select to authenticated using (public.is_admin());

revoke all on public.b2c_finance_row_overrides from anon, authenticated;
grant select on public.b2c_finance_row_overrides to authenticated;

create or replace function public.apply_b2c_finance_row_correction(
  p_finance_row_id uuid,
  p_occurred_on date,
  p_amount_usd numeric,
  p_customer_name text,
  p_category_raw text,
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
  effective_amount_usd numeric(20, 6);
  effective_customer_name text;
  effective_category_raw text;
  correction_effective_on date;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can correct a staged B2C Finance row';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A Finance correction reason must be between 3 and 1000 characters';
  end if;
  if p_occurred_on is null and p_amount_usd is null and p_customer_name is null and p_category_raw is null then
    raise exception 'Enter at least one verified Finance correction';
  end if;
  if p_amount_usd is not null and p_amount_usd <= 0 then
    raise exception 'A corrected Finance amount must be greater than zero';
  end if;
  if p_customer_name is not null and char_length(trim(p_customer_name)) not between 1 and 200 then
    raise exception 'A corrected customer name must be between 1 and 200 characters';
  end if;
  if p_category_raw is not null and char_length(trim(p_category_raw)) not between 1 and 200 then
    raise exception 'A corrected Finance category must be between 1 and 200 characters';
  end if;

  select * into source_row
  from public.b2c_finance_staging_rows
  where id = p_finance_row_id
  for update;
  if not found then
    raise exception 'The staged B2C Finance row is unavailable';
  end if;
  if exists (
    select 1 from public.b2c_finance_ledger_posts where finance_row_id = p_finance_row_id
  ) then
    raise exception 'A posted B2C Finance row cannot be corrected here';
  end if;

  select * into prior_override
  from public.b2c_finance_row_overrides
  where finance_row_id = p_finance_row_id
  for update;

  effective_occurred_on := coalesce(p_occurred_on, prior_override.occurred_on, source_row.occurred_on);
  effective_amount_usd := coalesce(p_amount_usd, prior_override.amount_usd, source_row.amount_usd);
  effective_customer_name := coalesce(nullif(trim(p_customer_name), ''), prior_override.customer_name, source_row.customer_name_raw);
  effective_category_raw := coalesce(nullif(trim(p_category_raw), ''), prior_override.category_raw, source_row.category_raw);
  correction_effective_on := effective_occurred_on;

  if correction_effective_on is null then
    raise exception 'Correct the Finance date before saving other values';
  end if;
  if effective_occurred_on is not distinct from coalesce(prior_override.occurred_on, source_row.occurred_on)
    and effective_amount_usd is not distinct from coalesce(prior_override.amount_usd, source_row.amount_usd)
    and effective_customer_name is not distinct from coalesce(prior_override.customer_name, source_row.customer_name_raw)
    and effective_category_raw is not distinct from coalesce(prior_override.category_raw, source_row.category_raw) then
    raise exception 'The submitted values do not change this Finance row';
  end if;

  insert into public.b2c_finance_row_overrides (
    finance_row_id, occurred_on, amount_usd, customer_name, category_raw,
    date_authority_confirmed_at, created_by, updated_by
  ) values (
    p_finance_row_id,
    case when p_occurred_on is null then prior_override.occurred_on else effective_occurred_on end,
    case when p_amount_usd is null then prior_override.amount_usd else effective_amount_usd end,
    case when p_customer_name is null then prior_override.customer_name else effective_customer_name end,
    case when p_category_raw is null then prior_override.category_raw else effective_category_raw end,
    prior_override.date_authority_confirmed_at,
    auth.uid(), auth.uid()
  ) on conflict (finance_row_id) do update set
    occurred_on = excluded.occurred_on,
    amount_usd = excluded.amount_usd,
    customer_name = excluded.customer_name,
    category_raw = excluded.category_raw,
    updated_by = auth.uid();

  if p_occurred_on is not null and p_occurred_on is distinct from coalesce(prior_override.occurred_on, source_row.occurred_on) then
    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values ('b2c_finance_row', p_finance_row_id, 'date', jsonb_build_object('occurred_on', coalesce(prior_override.occurred_on, source_row.occurred_on)), jsonb_build_object('occurred_on', effective_occurred_on), trim(p_reason), correction_effective_on);
  end if;
  if p_amount_usd is not null and p_amount_usd is distinct from coalesce(prior_override.amount_usd, source_row.amount_usd) then
    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values ('b2c_finance_row', p_finance_row_id, 'amount', jsonb_build_object('amount_usd', coalesce(prior_override.amount_usd, source_row.amount_usd)), jsonb_build_object('amount_usd', effective_amount_usd), trim(p_reason), correction_effective_on);
  end if;
  if p_customer_name is not null and nullif(trim(p_customer_name), '') is distinct from coalesce(prior_override.customer_name, source_row.customer_name_raw) then
    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values ('b2c_finance_row', p_finance_row_id, 'classification', jsonb_build_object('customer_name', coalesce(prior_override.customer_name, source_row.customer_name_raw)), jsonb_build_object('customer_name', effective_customer_name), trim(p_reason), correction_effective_on);
  end if;
  if p_category_raw is not null and nullif(trim(p_category_raw), '') is distinct from coalesce(prior_override.category_raw, source_row.category_raw) then
    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values ('b2c_finance_row', p_finance_row_id, 'category', jsonb_build_object('category_raw', coalesce(prior_override.category_raw, source_row.category_raw)), jsonb_build_object('category_raw', effective_category_raw), trim(p_reason), correction_effective_on);
  end if;
end;
$$;

create or replace function public.apply_b2c_finance_date_authority(
  p_finance_row_ids uuid[],
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  row_id uuid;
  resolved_rows integer := 0;
  source_row public.b2c_finance_staging_rows%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can confirm B2C Finance dates';
  end if;
  if coalesce(array_length(p_finance_row_ids, 1), 0) = 0 then
    raise exception 'Select at least one Finance row';
  end if;
  if (select count(*) from unnest(p_finance_row_ids) as selected(id)) <> (select count(distinct id) from unnest(p_finance_row_ids) as selected(id)) then
    raise exception 'Select each Finance row only once';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A Date-authority reason must be between 3 and 1000 characters';
  end if;

  foreach row_id in array p_finance_row_ids loop
    select * into source_row
    from public.b2c_finance_staging_rows
    where id = row_id
    for update;

    if not found
      or source_row.occurred_on is null
      or source_row.row_quality <> 'needs_review'
      or source_row.quality_issues = '[]'::jsonb
      or not source_row.quality_issues <@ '["declared_month_conflicts_with_date", "declared_year_conflicts_with_date"]'::jsonb then
      raise exception 'Every selected row must have a valid Finance date with only a Month or Year label conflict';
    end if;
    if exists (select 1 from public.b2c_finance_ledger_posts where finance_row_id = row_id) then
      raise exception 'A posted B2C Finance row cannot receive a Date-authority decision';
    end if;

    insert into public.b2c_finance_row_overrides (
      finance_row_id, date_authority_confirmed_at, created_by, updated_by
    ) values (
      row_id, timezone('utc', now()), auth.uid(), auth.uid()
    ) on conflict (finance_row_id) do update set
      date_authority_confirmed_at = excluded.date_authority_confirmed_at,
      updated_by = auth.uid();

    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values (
      'b2c_finance_row', row_id, 'date',
      jsonb_build_object('reported_date_raw', source_row.reported_date_raw, 'declared_month_raw', source_row.declared_month_raw, 'declared_year_raw', source_row.declared_year_raw),
      jsonb_build_object('effective_occurred_on', source_row.occurred_on, 'date_authority_confirmed', true),
      trim(p_reason), source_row.occurred_on
    );
    resolved_rows := resolved_rows + 1;
  end loop;

  return resolved_rows;
end;
$$;

create view public.b2c_finance_effective_rows
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
  rows.category_raw,
  rows.membership_type_raw,
  rows.payment_method_raw,
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
    when rows.row_quality = 'valid' then 'valid'::public.b2c_finance_row_quality
    when overrides.date_authority_confirmed_at is not null
      and rows.occurred_on is not null
      and rows.quality_issues <> '[]'::jsonb
      and rows.quality_issues <@ '["declared_month_conflicts_with_date", "declared_year_conflicts_with_date"]'::jsonb
      then 'valid'::public.b2c_finance_row_quality
    else rows.row_quality
  end as effective_quality
from public.b2c_finance_staging_rows rows
left join public.b2c_finance_row_overrides overrides on overrides.finance_row_id = rows.id;

revoke all on function public.assign_b2c_finance_row_override_actor() from public;
revoke all on function public.apply_b2c_finance_row_correction(uuid, date, numeric, text, text, text) from public;
revoke all on function public.apply_b2c_finance_date_authority(uuid[], text) from public;
grant execute on function public.apply_b2c_finance_row_correction(uuid, date, numeric, text, text, text) to authenticated;
grant execute on function public.apply_b2c_finance_date_authority(uuid[], text) to authenticated;
revoke all on public.b2c_finance_effective_rows from public;
grant select on public.b2c_finance_effective_rows to authenticated;

-- Post from the effective view so an audited correction or Date-authority
-- decision can be used without ever changing the uploaded workbook evidence.
create or replace function public.post_approved_b2c_finance_payments()
returns table (
  posted_payments integer,
  already_posted_payments integer,
  skipped_rows integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  supported_rows integer := 0;
  already_posted integer := 0;
  posted integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can post approved B2C Finance payments';
  end if;

  with supported_rows as (
    select rows.id
    from public.b2c_finance_effective_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g')) in ('bank transfer', 'ios')
  )
  select count(*) into supported_rows from supported_rows;

  with supported_rows as (
    select rows.id
    from public.b2c_finance_effective_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g')) in ('bank transfer', 'ios')
  )
  select count(*) into already_posted
  from supported_rows rows
  join public.b2c_finance_ledger_posts posts on posts.finance_row_id = rows.id;

  with eligible_rows as (
    select
      rows.id,
      rows.import_id,
      rows.source_tab,
      rows.source_row_number,
      rows.occurred_on,
      rows.amount_usd,
      rows.source_occurred_on,
      rows.source_amount_usd,
      nullif(trim(rows.customer_name), '') as customer_name,
      nullif(lower(trim(rows.customer_email_raw)), '') as customer_email,
      nullif(trim(rows.customer_phone_raw), '') as customer_phone,
      nullif(trim(rows.membership_type_raw), '') as membership_tier,
      nullif(trim(rows.category_raw), '') as category_raw,
      case trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g'))
        when 'bank transfer' then 'bank_transfer'
        when 'ios' then 'ios'
      end as finance_payment_method,
      regexp_replace(
        regexp_replace(lower(trim(coalesce(rows.category_raw, ''))), '[^a-z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      ) as category_code
    from public.b2c_finance_effective_rows rows
    join public.b2c_finance_staging_rows source_rows on source_rows.id = rows.id
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and rows.effective_quality = 'valid'
      and rows.amount_usd > 0
      and rows.occurred_on is not null
      and trim(regexp_replace(lower(coalesce(rows.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g')) in ('bank transfer', 'ios')
      and not exists (
        select 1
        from public.b2c_finance_ledger_posts posts
        where posts.finance_row_id = rows.id
      )
      and not exists (
        select 1
        from public.b2c_reconciliation_finance_rows group_rows
        join public.b2c_reconciliation_groups groups on groups.id = group_rows.reconciliation_group_id
        where group_rows.finance_row_id = rows.id
          and (groups.reconciliation_state <> 'canonical' or groups.canonical_finance_row_id <> rows.id)
      )
    for update of source_rows
  ),
  postable_rows as (
    select *
    from eligible_rows rows
    where rows.finance_payment_method is not null
      and rows.category_code <> ''
  ),
  inserted_payments as (
    insert into public.b2c_payments (
      source_system, provider_transaction_id, provider_event_id,
      customer_name, customer_email, customer_phone,
      category_code, membership_tier, payment_status,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, tax_amount_usd, net_amount_usd,
      occurred_at, occurred_on, duplicate_fingerprint,
      reconciliation_source, source_metadata
    )
    select
      'finance_tracker', null, null,
      rows.customer_name, rows.customer_email, rows.customer_phone,
      rows.category_code, rows.membership_tier, 'succeeded',
      rows.amount_usd, 'USD', 1,
      rows.amount_usd, rows.amount_usd, null, null,
      rows.occurred_on::timestamp at time zone 'UTC', rows.occurred_on,
      encode(digest(rows.id::text, 'sha256'), 'hex'),
      'payment_tracker',
      jsonb_build_object(
        'finance_row_id', rows.id,
        'finance_import_id', rows.import_id,
        'source_tab', rows.source_tab,
        'source_row_number', rows.source_row_number,
        'finance_payment_method', rows.finance_payment_method,
        'raw_category', rows.category_raw,
        'membership_type', rows.membership_tier,
        'source_occurred_on', rows.source_occurred_on,
        'source_amount_usd', rows.source_amount_usd,
        'effective_occurred_on', rows.occurred_on,
        'effective_amount_usd', rows.amount_usd,
        'effective_category', rows.category_raw,
        'source_amount_basis', 'gross_excluding_vat'
      )
    from postable_rows rows
    returning id, source_metadata
  ),
  inserted_posts as (
    insert into public.b2c_finance_ledger_posts (
      finance_row_id, payment_id, finance_payment_method,
      source_amount_basis, posted_by
    )
    select
      (payments.source_metadata ->> 'finance_row_id')::uuid,
      payments.id,
      payments.source_metadata ->> 'finance_payment_method',
      'gross_excluding_vat',
      auth.uid()
    from inserted_payments payments
    returning finance_row_id
  )
  select count(*) into posted from inserted_posts;

  return query select posted, already_posted, greatest(supported_rows - posted - already_posted, 0);
end;
$$;

revoke all on function public.post_approved_b2c_finance_payments() from public;
grant execute on function public.post_approved_b2c_finance_payments() to authenticated;
