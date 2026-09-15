-- Clean-slate consolidated migration: Finance, Targets, Summit, Review Queue,
-- Audit, Integration operations, and Report archives. This migration depends
-- only on 20270101000000_foundation_and_access.sql.

create type public.target_status as enum ('draft', 'active', 'archived');
create type public.operational_target_value_kind as enum ('money_usd', 'quantity');

-- Corrections deliberately use an area + UUID reference rather than a foreign
-- key: they retain an append-only trail across independent financial domains.
create table public.financial_corrections (
  id uuid primary key default gen_random_uuid(),
  target_area text not null check (target_area in (
    'b2c_payment', 'b2c_refund', 'product_mapping',
    'b2b_deal', 'b2b_booking', 'b2b_recognised_sale', 'expense'
  )),
  target_record_id uuid not null,
  correction_type text not null check (correction_type in ('amount', 'date', 'category', 'classification', 'other')),
  before_value jsonb not null,
  after_value jsonb not null,
  reason text not null check (char_length(trim(reason)) > 0),
  effective_on date not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (before_value <> after_value)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_category text not null check (char_length(trim(expense_category)) > 0),
  description text not null check (char_length(trim(description)) > 0),
  original_amount numeric(20, 6) not null check (original_amount >= 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd >= 0),
  incurred_on date not null,
  source_reference text,
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.cash_position_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_label text not null check (char_length(trim(account_label)) > 0),
  snapshot_on date not null,
  original_amount numeric(20, 6) not null,
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null,
  source_reference text,
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (account_label, snapshot_on)
);

create table public.financial_targets (
  id uuid primary key default gen_random_uuid(),
  target_lineage_id uuid not null default gen_random_uuid(),
  revision_number integer not null default 1 check (revision_number > 0),
  metric_code text not null,
  period_start date not null,
  period_end date not null,
  target_amount_usd numeric(20, 6) not null check (target_amount_usd >= 0),
  notes text,
  status public.target_status not null default 'draft',
  finance_reference text not null default 'Initial Finance target' check (char_length(trim(finance_reference)) > 0),
  revision_reason text not null default 'Initial target definition' check (char_length(trim(revision_reason)) > 0),
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  constraint financial_targets_metric_code_check check (metric_code ~ '^[a-z0-9][a-z0-9_-]*$'),
  constraint financial_targets_approved_metric_check check (metric_code in (
    'b2c_cash_received', 'b2b_bookings', 'b2b_recognised_sales', 'total_recognised_sales'
  ))
);

create unique index financial_targets_current_metric_period_idx
  on public.financial_targets (metric_code, period_start, period_end)
  where status in ('draft', 'active');
create unique index financial_targets_lineage_revision_idx
  on public.financial_targets (target_lineage_id, revision_number);
create index financial_targets_period_idx on public.financial_targets (period_start, period_end);

create table public.operational_targets (
  id uuid primary key default gen_random_uuid(),
  target_lineage_id uuid not null default gen_random_uuid(),
  revision_number integer not null default 1 check (revision_number > 0),
  display_name text not null check (char_length(trim(display_name)) between 1 and 160),
  value_kind public.operational_target_value_kind not null,
  target_value numeric(20, 6) not null check (target_value >= 0),
  unit_label text,
  period_start date not null,
  period_end date not null,
  status public.target_status not null default 'draft',
  finance_reference text not null check (char_length(trim(finance_reference)) between 1 and 1000),
  revision_reason text not null check (char_length(trim(revision_reason)) between 1 and 1000),
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  constraint operational_target_quantity_unit_check check (
    (value_kind = 'quantity' and char_length(trim(coalesce(unit_label, ''))) > 0)
    or (value_kind = 'money_usd' and unit_label is null)
  ),
  unique (target_lineage_id, revision_number)
);

create table public.operational_target_progress_updates (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.operational_targets(id),
  actual_value numeric(20, 6) not null check (actual_value >= 0),
  effective_on date not null,
  evidence_note text not null check (char_length(trim(evidence_note)) between 1 and 1000),
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index operational_targets_current_period_idx
  on public.operational_targets (period_start, period_end)
  where status in ('draft', 'active');
create index operational_targets_lineage_revision_idx
  on public.operational_targets (target_lineage_id, revision_number);
create index operational_target_progress_target_date_idx
  on public.operational_target_progress_updates (target_id, effective_on desc, created_at desc);

create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$' and base_currency <> 'USD'),
  quote_currency char(3) not null default 'USD' check (quote_currency = 'USD'),
  rate numeric(20, 10) not null check (rate > 0),
  source_system text not null check (source_system in ('manual_finance', 'provider')),
  source_reference text,
  entered_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (rate_date, base_currency, quote_currency, source_system)
);

create table public.summit_targets (
  id uuid primary key default gen_random_uuid(),
  metric_code text not null check (metric_code in ('tickets', 'sponsors', 'booths', 'revenue', 'costs')),
  period_start date not null,
  period_end date not null,
  target_value numeric(20, 6) not null check (target_value >= 0),
  value_currency char(3) check (value_currency is null or value_currency ~ '^[A-Z]{3}$'),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  check ((metric_code in ('revenue', 'costs') and value_currency is not null)
    or (metric_code not in ('revenue', 'costs') and value_currency is null)),
  unique (metric_code, period_start, period_end)
);

create table public.summit_updates (
  id uuid primary key default gen_random_uuid(),
  metric_code text not null check (metric_code in ('tickets', 'sponsors', 'booths', 'revenue', 'costs')),
  update_date date not null,
  value numeric(20, 6) not null,
  original_currency char(3) check (original_currency is null or original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) check (exchange_rate_to_usd is null or exchange_rate_to_usd > 0),
  value_usd numeric(20, 6),
  reason_or_reference text not null check (char_length(trim(reason_or_reference)) > 0),
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check ((metric_code in ('revenue', 'costs') and original_currency is not null and exchange_rate_to_usd is not null and value_usd is not null)
    or (metric_code not in ('revenue', 'costs') and original_currency is null and exchange_rate_to_usd is null and value_usd is null))
);

create index summit_updates_metric_date_idx on public.summit_updates (metric_code, update_date desc);

create table public.data_coverage (
  id uuid primary key default gen_random_uuid(),
  domain_area text not null check (domain_area in ('b2c', 'b2b', 'finance', 'summit')),
  source_system text not null,
  period_start date not null,
  period_end date not null,
  coverage_status public.backfill_status not null,
  source_record_count integer check (source_record_count is null or source_record_count >= 0),
  notes text,
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  unique (domain_area, source_system, period_start, period_end)
);

create index data_coverage_period_idx
  on public.data_coverage (domain_area, source_system, period_start, period_end);

-- Review source references are intentionally generic. A flag may concern any
-- supported source area, including records owned by the B2B/B2C migrations.
create table public.review_flags (
  id uuid primary key default gen_random_uuid(),
  source_area text not null check (source_area in (
    'b2c_payment', 'b2c_refund', 'b2b_deal', 'b2b_booking',
    'b2b_recognised_sale', 'product_mapping', 'integration'
  )),
  source_record_id uuid not null,
  flag_type public.review_flag_type not null,
  status public.review_flag_status not null default 'open',
  priority smallint not null default 3 check (priority between 1 and 5),
  reason text not null check (char_length(trim(reason)) > 0),
  assigned_to uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((status = 'open' and resolved_by is null and resolved_at is null)
    or (status in ('resolved', 'dismissed') and resolved_by is not null and resolved_at is not null))
);

create table public.review_flag_resolutions (
  id uuid primary key default gen_random_uuid(),
  flag_id uuid not null unique references public.review_flags(id),
  resolution_status public.review_flag_status not null check (resolution_status in ('resolved', 'dismissed')),
  resolution_note text not null check (char_length(trim(resolution_note)) > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.review_notes (
  id uuid primary key default gen_random_uuid(),
  flag_id uuid not null references public.review_flags(id),
  note text not null check (char_length(trim(note)) > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index review_flags_status_priority_idx on public.review_flags (status, priority, created_at desc);
create index review_flags_assigned_to_idx on public.review_flags (assigned_to, status) where assigned_to is not null;
create unique index review_flags_one_status_per_b2b_deal
  on public.review_flags (source_area, source_record_id, flag_type, status);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id),
  actor_email citext,
  area text not null,
  record_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_value jsonb,
  after_value jsonb,
  reason text,
  request_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  check (before_value is not null or after_value is not null)
);

create index audit_events_occurred_at_idx on public.audit_events (occurred_at desc);
create index audit_events_record_idx on public.audit_events (area, record_id, occurred_at desc);

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  status public.integration_status not null default 'pending',
  operation_type text not null default 'reconciliation' check (operation_type in ('reconciliation', 'historical_backfill')),
  continuation_cursor text,
  records_processed integer not null default 0 check (records_processed >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  retry_count integer not null default 0 check (retry_count >= 0),
  safe_error_summary text,
  requested_range_start timestamptz,
  requested_range_end timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (requested_range_end is null or requested_range_start is not null),
  check (requested_range_start is null or requested_range_end >= requested_range_start),
  check ((status <> 'failed') or (failed_at is not null and safe_error_summary is not null))
);

create index integration_sync_runs_hubspot_backfill_status_idx
  on public.integration_sync_runs (provider, operation_type, status, created_at desc);

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  external_event_id text not null,
  event_type text not null,
  status public.integration_status not null default 'pending',
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  safe_metadata jsonb not null default '{}'::jsonb,
  sync_run_id uuid references public.integration_sync_runs(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (provider, external_event_id)
);

create index integration_events_status_received_at_idx on public.integration_events (status, received_at desc);

create table public.integration_errors (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  integration_event_id uuid references public.integration_events(id),
  sync_run_id uuid references public.integration_sync_runs(id),
  safe_error_summary text not null,
  source_reference text check (source_reference is null or char_length(source_reference) between 1 and 300),
  occurred_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_note text,
  created_at timestamptz not null default timezone('utc', now()),
  check (resolved_at is null or resolved_by is not null),
  check (
    (resolved_at is null and resolved_by is null and resolution_note is null)
    or (resolved_at is not null and resolved_by is not null and char_length(trim(resolution_note)) > 0)
  )
);

create index integration_errors_provider_occurred_at_idx on public.integration_errors (provider, occurred_at desc);
create index integration_errors_hubspot_open_source_reference_idx
  on public.integration_errors (provider, source_reference, occurred_at desc)
  where resolved_at is null;

create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  lookback_start timestamptz not null,
  lookback_end timestamptz not null,
  status public.integration_status not null default 'pending',
  records_examined integer not null default 0 check (records_examined >= 0),
  records_inserted integer not null default 0 check (records_inserted >= 0),
  duplicates_detected integer not null default 0 check (duplicates_detected >= 0),
  safe_error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (lookback_end >= lookback_start),
  check (lookback_end - lookback_start <= interval '48 hours'),
  check ((status <> 'failed') or safe_error_summary is not null)
);

create table public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  report_type public.report_type not null,
  period_start date not null,
  period_end date not null,
  status public.report_job_status not null default 'pending',
  requested_by uuid references public.profiles(id),
  requested_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  retry_count integer not null default 0 check (retry_count >= 0),
  delivery_requested boolean not null default false,
  generation_mode text not null default 'draft_fixture' check (generation_mode in ('draft_fixture', 'financial')),
  safe_error_summary text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  check ((status <> 'failed') or (failed_at is not null and safe_error_summary is not null)),
  check ((status <> 'completed') or completed_at is not null)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.report_jobs(id),
  generated_at timestamptz not null default timezone('utc', now()),
  summary_snapshot jsonb not null default '{}'::jsonb,
  snapshot_version text not null default '1',
  readiness_status text not null default 'draft_fixture_only' check (readiness_status in ('draft_fixture_only', 'financial_ready')),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.report_files (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id),
  file_kind text not null check (file_kind in ('pdf', 'csv_bundle')),
  storage_bucket text not null check (char_length(trim(storage_bucket)) > 0),
  storage_path text not null check (char_length(trim(storage_path)) > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (report_id, file_kind),
  unique (storage_bucket, storage_path)
);

create table public.report_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id),
  recipient_email citext not null,
  status public.integration_status not null default 'pending',
  requested_at timestamptz not null default timezone('utc', now()),
  sent_at timestamptz,
  failed_at timestamptz,
  safe_error_summary text,
  created_at timestamptz not null default timezone('utc', now()),
  check ((status <> 'failed') or (failed_at is not null and safe_error_summary is not null))
);

create index report_jobs_period_status_idx on public.report_jobs (period_start, period_end, status);
create index report_delivery_attempts_report_idx on public.report_delivery_attempts (report_id, requested_at desc);

create or replace function public.assign_finance_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Financial admin entries require an authenticated administrator';
  end if;

  if tg_table_name = 'financial_corrections' then
    new.created_by := auth.uid();
  elsif tg_table_name in ('expenses', 'cash_position_snapshots', 'summit_updates', 'operational_target_progress_updates') then
    new.entered_by := auth.uid();
  elsif tg_table_name = 'exchange_rates' then
    if to_jsonb(new) ->> 'source_system' = 'manual_finance' then
      new.entered_by := auth.uid();
    end if;
  elsif tg_table_name in ('financial_targets', 'summit_targets', 'operational_targets') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    end if;
    new.updated_by := auth.uid();
  elsif tg_table_name = 'data_coverage' then
    new.recorded_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.assign_financial_correction_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Financial corrections require an authenticated administrator';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

create or replace function public.prevent_active_target_definition_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'active' and (
    new.status <> 'archived'
    or new.archived_at is null
    or (to_jsonb(new) - 'status' - 'archived_at' - 'updated_by' - 'updated_at')
       is distinct from (to_jsonb(old) - 'status' - 'archived_at' - 'updated_by' - 'updated_at')
  ) then
    raise exception 'Active target definitions must be revised, not overwritten';
  end if;
  return new;
end;
$$;

create or replace function public.require_active_operational_target()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_status_value public.target_status;
begin
  select status into target_status_value
  from public.operational_targets
  where id = new.target_id
  for key share;
  if target_status_value is distinct from 'active' then
    raise exception 'Operational progress requires an active target';
  end if;
  return new;
end;
$$;

create or replace function public.apply_review_resolution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Review resolutions require an authenticated administrator';
  end if;
  new.created_by := auth.uid();

  update public.review_flags
  set status = new.resolution_status,
      resolved_by = auth.uid(),
      resolved_at = timezone('utc', now())
  where id = new.flag_id
    and status = 'open';

  if not found then
    raise exception 'Only an open review flag can be resolved';
  end if;
  return new;
end;
$$;

create or replace function public.assign_review_note_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Review notes require an authenticated administrator';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

create or replace function public.assign_integration_error_resolver()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.resolved_at is not null and old.resolved_at is null then
    if auth.uid() is null then
      raise exception 'Integration error resolution requires an authenticated administrator';
    end if;
    new.resolved_by := auth.uid();
    new.resolved_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

-- Audit rows are append-only snapshots generated by table triggers. They are
-- never writable through RLS policies.
create or replace function public.write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  before_snapshot jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_snapshot jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  changed_record_id uuid;
  actor_email_snapshot citext;
begin
  changed_record_id := coalesce(
    nullif(after_snapshot ->> 'id', '')::uuid,
    nullif(before_snapshot ->> 'id', '')::uuid,
    nullif(after_snapshot ->> 'profile_id', '')::uuid,
    nullif(before_snapshot ->> 'profile_id', '')::uuid
  );

  select email into actor_email_snapshot from public.profiles where id = auth.uid();

  insert into public.audit_events (
    actor_profile_id, actor_email, area, record_id, action,
    before_value, after_value, reason
  ) values (
    auth.uid(), actor_email_snapshot, tg_table_name, changed_record_id, lower(tg_op),
    before_snapshot, after_snapshot,
    coalesce(after_snapshot ->> 'reason', after_snapshot ->> 'manual_entry_reason',
      after_snapshot ->> 'reason_or_reference', after_snapshot ->> 'resolution_note',
      before_snapshot ->> 'reason')
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.resolve_b2c_review_flag(
  p_flag_id uuid,
  p_resolution_status public.review_flag_status,
  p_resolution_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can resolve a B2C review item';
  end if;
  if p_resolution_status not in ('resolved', 'dismissed') or char_length(trim(p_resolution_note)) = 0 then
    raise exception 'A resolution status and note are required';
  end if;
  if not exists (
    select 1 from public.review_flags
    where id = p_flag_id
      and source_area in ('b2c_payment', 'b2c_refund')
      and status = 'open'
  ) then
    raise exception 'The B2C review item is unavailable or already resolved';
  end if;
  if exists (
    select 1 from public.review_flags
    where id = p_flag_id
      and source_area in ('b2c_payment', 'b2c_refund')
      and flag_type = 'possible_duplicate'
      and status = 'open'
  ) then
    raise exception 'Possible duplicates must be decided through the dedicated duplicate workflow';
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  values (p_flag_id, p_resolution_status, trim(p_resolution_note));
end;
$$;

create or replace function public.revise_financial_target(
  p_target_id uuid,
  p_metric_code text,
  p_period_start date,
  p_period_end date,
  p_target_amount_usd numeric,
  p_finance_reference text,
  p_revision_reason text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  prior public.financial_targets%rowtype;
  successor_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admin access is required';
  end if;
  select * into prior
  from public.financial_targets
  where id = p_target_id and status = 'active'
  for update;
  if not found then
    raise exception 'Active financial target not found';
  end if;
  if p_period_end < p_period_start or p_target_amount_usd < 0
    or trim(p_finance_reference) = '' or trim(p_revision_reason) = '' then
    raise exception 'Invalid target revision';
  end if;

  update public.financial_targets
  set status = 'archived', archived_at = timezone('utc', now())
  where id = prior.id;

  insert into public.financial_targets (
    target_lineage_id, revision_number, metric_code, period_start, period_end,
    target_amount_usd, status, finance_reference, revision_reason
  ) values (
    prior.target_lineage_id, prior.revision_number + 1, p_metric_code,
    p_period_start, p_period_end, p_target_amount_usd, 'active',
    trim(p_finance_reference), trim(p_revision_reason)
  ) returning id into successor_id;
  return successor_id;
end;
$$;

create or replace function public.revise_operational_target(
  p_target_id uuid,
  p_display_name text,
  p_value_kind public.operational_target_value_kind,
  p_target_value numeric,
  p_unit_label text,
  p_period_start date,
  p_period_end date,
  p_finance_reference text,
  p_revision_reason text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  prior public.operational_targets%rowtype;
  successor_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admin access is required';
  end if;
  select * into prior
  from public.operational_targets
  where id = p_target_id and status = 'active'
  for update;
  if not found then
    raise exception 'Active operational target not found';
  end if;
  if trim(p_display_name) = ''
    or p_period_end < p_period_start
    or p_target_value < 0
    or trim(p_finance_reference) = ''
    or trim(p_revision_reason) = ''
    or (p_value_kind = 'quantity' and trim(coalesce(p_unit_label, '')) = '')
    or (p_value_kind = 'money_usd' and p_unit_label is not null) then
    raise exception 'Invalid operational target revision';
  end if;

  update public.operational_targets
  set status = 'archived', archived_at = timezone('utc', now())
  where id = prior.id;

  insert into public.operational_targets (
    target_lineage_id, revision_number, display_name, value_kind, target_value,
    unit_label, period_start, period_end, status, finance_reference, revision_reason
  ) values (
    prior.target_lineage_id, prior.revision_number + 1, trim(p_display_name),
    p_value_kind, p_target_value,
    case when p_value_kind = 'money_usd' then null else trim(p_unit_label) end,
    p_period_start, p_period_end, 'active', trim(p_finance_reference),
    trim(p_revision_reason)
  ) returning id into successor_id;
  return successor_id;
end;
$$;

create trigger assign_financial_correction_actor
  before insert on public.financial_corrections
  for each row execute procedure public.assign_financial_correction_actor();
create trigger assign_expense_actor before insert on public.expenses
  for each row execute procedure public.assign_finance_actor();
create trigger assign_cash_snapshot_actor before insert on public.cash_position_snapshots
  for each row execute procedure public.assign_finance_actor();
create trigger assign_financial_target_actor before insert or update on public.financial_targets
  for each row execute procedure public.assign_finance_actor();
create trigger assign_exchange_rate_actor before insert on public.exchange_rates
  for each row execute procedure public.assign_finance_actor();
create trigger assign_summit_target_actor before insert or update on public.summit_targets
  for each row execute procedure public.assign_finance_actor();
create trigger assign_summit_update_actor before insert on public.summit_updates
  for each row execute procedure public.assign_finance_actor();
create trigger assign_coverage_actor before insert or update on public.data_coverage
  for each row execute procedure public.assign_finance_actor();
create trigger assign_operational_target_actor before insert or update on public.operational_targets
  for each row execute procedure public.assign_finance_actor();
create trigger assign_operational_target_progress_actor before insert on public.operational_target_progress_updates
  for each row execute procedure public.assign_finance_actor();
create trigger require_active_operational_target before insert on public.operational_target_progress_updates
  for each row execute procedure public.require_active_operational_target();
create trigger prevent_financial_target_active_mutation before update on public.financial_targets
  for each row execute procedure public.prevent_active_target_definition_mutation();
create trigger prevent_operational_target_active_mutation before update on public.operational_targets
  for each row execute procedure public.prevent_active_target_definition_mutation();
create trigger set_financial_targets_updated_at before update on public.financial_targets
  for each row execute procedure public.set_updated_at();
create trigger set_operational_targets_updated_at before update on public.operational_targets
  for each row execute procedure public.set_updated_at();
create trigger set_summit_targets_updated_at before update on public.summit_targets
  for each row execute procedure public.set_updated_at();
create trigger set_data_coverage_updated_at before update on public.data_coverage
  for each row execute procedure public.set_updated_at();
create trigger resolve_review_flag before insert on public.review_flag_resolutions
  for each row execute procedure public.apply_review_resolution();
create trigger assign_review_note_actor before insert on public.review_notes
  for each row execute procedure public.assign_review_note_actor();
create trigger set_review_flags_updated_at before update on public.review_flags
  for each row execute procedure public.set_updated_at();
create trigger assign_integration_error_resolver before update on public.integration_errors
  for each row execute procedure public.assign_integration_error_resolver();
create trigger set_report_jobs_updated_at before update on public.report_jobs
  for each row execute procedure public.set_updated_at();

do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'financial_corrections', 'expenses', 'cash_position_snapshots',
    'financial_targets', 'operational_targets', 'operational_target_progress_updates',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes',
    'integration_sync_runs', 'integration_events', 'integration_errors',
    'reconciliation_runs', 'report_jobs', 'reports', 'report_files',
    'report_delivery_attempts'
  ] loop
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute procedure public.write_audit_event()',
      audited_table
    );
  end loop;
end;
$$;

do $$
declare
  secured_table text;
begin
  foreach secured_table in array array[
    'financial_corrections', 'expenses', 'cash_position_snapshots',
    'financial_targets', 'operational_targets', 'operational_target_progress_updates',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes', 'audit_events',
    'integration_sync_runs', 'integration_events', 'integration_errors',
    'reconciliation_runs', 'report_jobs', 'reports', 'report_files',
    'report_delivery_attempts'
  ] loop
    execute format('alter table public.%I enable row level security', secured_table);
  end loop;
end;
$$;

do $$
declare
  readable_table text;
begin
  foreach readable_table in array array[
    'financial_corrections', 'expenses', 'cash_position_snapshots',
    'financial_targets', 'operational_targets', 'operational_target_progress_updates',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes',
    'report_jobs', 'reports', 'report_files', 'report_delivery_attempts'
  ] loop
    execute format(
      'create policy approved_read on public.%I for select to authenticated using (public.is_approved_user())',
      readable_table
    );
  end loop;
end;
$$;

create policy audit_events_read_admin on public.audit_events for select to authenticated
  using (public.is_admin());

do $$
declare
  admin_log_table text;
begin
  foreach admin_log_table in array array[
    'integration_sync_runs', 'integration_events', 'integration_errors', 'reconciliation_runs'
  ] loop
    execute format('create policy admin_read on public.%I for select to authenticated using (public.is_admin())', admin_log_table);
  end loop;
end;
$$;

do $$
declare
  insert_table text;
begin
  foreach insert_table in array array[
    'financial_corrections', 'expenses', 'cash_position_snapshots',
    'financial_targets', 'operational_targets', 'operational_target_progress_updates',
    'exchange_rates', 'summit_targets', 'summit_updates', 'data_coverage',
    'review_flags', 'review_flag_resolutions', 'review_notes',
    'integration_sync_runs', 'integration_events', 'integration_errors',
    'reconciliation_runs', 'report_jobs', 'reports', 'report_files',
    'report_delivery_attempts'
  ] loop
    execute format('create policy admin_insert on public.%I for insert to authenticated with check (public.is_admin())', insert_table);
  end loop;
end;
$$;

do $$
declare
  update_table text;
begin
  foreach update_table in array array[
    'financial_targets', 'operational_targets', 'summit_targets', 'data_coverage',
    'integration_sync_runs', 'integration_events', 'integration_errors',
    'reconciliation_runs', 'report_jobs', 'reports', 'report_files',
    'report_delivery_attempts'
  ] loop
    execute format(
      'create policy admin_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
      update_table
    );
  end loop;
end;
$$;

grant select on table
  public.financial_corrections, public.expenses, public.cash_position_snapshots,
  public.financial_targets, public.operational_targets, public.operational_target_progress_updates,
  public.exchange_rates, public.summit_targets, public.summit_updates, public.data_coverage,
  public.review_flags, public.review_flag_resolutions, public.review_notes, public.audit_events,
  public.integration_sync_runs, public.integration_events, public.integration_errors,
  public.reconciliation_runs, public.report_jobs, public.reports, public.report_files,
  public.report_delivery_attempts
to authenticated;

grant insert on table
  public.financial_corrections, public.expenses, public.cash_position_snapshots,
  public.financial_targets, public.operational_targets, public.operational_target_progress_updates,
  public.exchange_rates, public.summit_targets, public.summit_updates, public.data_coverage,
  public.review_flags, public.review_flag_resolutions, public.review_notes,
  public.integration_sync_runs, public.integration_events, public.integration_errors,
  public.reconciliation_runs, public.report_jobs, public.reports, public.report_files,
  public.report_delivery_attempts
to authenticated;

grant update on table
  public.financial_targets, public.operational_targets, public.summit_targets,
  public.data_coverage, public.integration_sync_runs, public.integration_events,
  public.integration_errors, public.reconciliation_runs, public.report_jobs,
  public.reports, public.report_files, public.report_delivery_attempts
to authenticated;

revoke all on function public.assign_finance_actor() from public;
revoke all on function public.assign_financial_correction_actor() from public;
revoke all on function public.prevent_active_target_definition_mutation() from public;
revoke all on function public.require_active_operational_target() from public;
revoke all on function public.apply_review_resolution() from public;
revoke all on function public.assign_review_note_actor() from public;
revoke all on function public.assign_integration_error_resolver() from public;
revoke all on function public.write_audit_event() from public;
revoke all on function public.resolve_b2c_review_flag(uuid, public.review_flag_status, text) from public;
revoke all on function public.revise_financial_target(uuid, text, date, date, numeric, text, text) from public;
revoke all on function public.revise_operational_target(uuid, text, public.operational_target_value_kind, numeric, text, date, date, text, text) from public;
grant execute on function public.resolve_b2c_review_flag(uuid, public.review_flag_status, text) to authenticated;
grant execute on function public.revise_financial_target(uuid, text, date, date, numeric, text, text) to authenticated;
grant execute on function public.revise_operational_target(uuid, text, public.operational_target_value_kind, numeric, text, date, date, text, text) to authenticated;

insert into storage.buckets (id, name, public)
values ('report-archives', 'report-archives', false)
on conflict (id) do update set public = false;

create policy "approved users can read report archives"
on storage.objects for select to authenticated
using (bucket_id = 'report-archives' and public.is_approved_user());

create policy "admins can archive reports"
on storage.objects for insert to authenticated
with check (bucket_id = 'report-archives' and public.is_admin());

create policy "admins can replace report archives"
on storage.objects for update to authenticated
using (bucket_id = 'report-archives' and public.is_admin())
with check (bucket_id = 'report-archives' and public.is_admin());
