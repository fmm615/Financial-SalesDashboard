-- Target definitions are controlled Finance configuration. Financial goals remain
-- separate from manually updated operational metrics and never store manual actuals.
create type public.target_status as enum ('draft', 'active', 'archived');
create type public.operational_target_value_kind as enum ('money_usd', 'quantity');

alter table public.financial_targets
  add column target_lineage_id uuid,
  add column revision_number integer not null default 1 check (revision_number > 0),
  add column status public.target_status not null default 'draft',
  add column finance_reference text not null default 'Initial Finance target' check (char_length(trim(finance_reference)) > 0),
  add column revision_reason text not null default 'Initial target definition' check (char_length(trim(revision_reason)) > 0),
  add column archived_at timestamptz;

-- This one-time structural backfill runs in the SQL editor, not as an
-- application Admin request. Keep the normal actor trigger enabled for every
-- later target write, but disable it while populating a non-financial lineage.
alter table public.financial_targets disable trigger assign_financial_target_actor;
update public.financial_targets set target_lineage_id = id where target_lineage_id is null;
alter table public.financial_targets enable trigger assign_financial_target_actor;
alter table public.financial_targets alter column target_lineage_id set not null;
alter table public.financial_targets alter column target_lineage_id set default gen_random_uuid();
alter table public.financial_targets
  add constraint financial_targets_metric_code_check
  check (metric_code in ('b2c_cash_received', 'b2b_bookings', 'b2b_recognised_sales', 'total_recognised_sales')) not valid;
alter table public.financial_targets
  drop constraint financial_targets_metric_code_period_start_period_end_key;
create unique index financial_targets_current_metric_period_idx
  on public.financial_targets (metric_code, period_start, period_end)
  where status in ('draft', 'active');
create unique index financial_targets_lineage_revision_idx
  on public.financial_targets (target_lineage_id, revision_number);

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
declare target_status_value public.target_status;
begin
  select status into target_status_value from public.operational_targets where id = new.target_id for key share;
  if target_status_value is distinct from 'active' then
    raise exception 'Operational progress requires an active target';
  end if;
  return new;
end;
$$;

create trigger assign_operational_target_actor before insert or update on public.operational_targets
  for each row execute procedure public.assign_finance_actor();
create trigger set_operational_targets_updated_at before update on public.operational_targets
  for each row execute procedure public.set_updated_at();
create trigger prevent_financial_target_active_mutation before update on public.financial_targets
  for each row execute procedure public.prevent_active_target_definition_mutation();
create trigger prevent_operational_target_active_mutation before update on public.operational_targets
  for each row execute procedure public.prevent_active_target_definition_mutation();
create trigger assign_operational_target_progress_actor before insert on public.operational_target_progress_updates
  for each row execute procedure public.assign_finance_actor();
create trigger require_active_operational_target before insert on public.operational_target_progress_updates
  for each row execute procedure public.require_active_operational_target();
create trigger audit_operational_targets after insert or update or delete on public.operational_targets
  for each row execute procedure public.write_audit_event();
create trigger audit_operational_target_progress_updates after insert or update or delete on public.operational_target_progress_updates
  for each row execute procedure public.write_audit_event();

alter table public.operational_targets enable row level security;
alter table public.operational_target_progress_updates enable row level security;
create policy approved_read on public.operational_targets for select to authenticated
  using (public.is_approved_user());
create policy approved_read on public.operational_target_progress_updates for select to authenticated
  using (public.is_approved_user());
create policy admin_insert on public.operational_targets for insert to authenticated
  with check (public.is_admin());
create policy admin_insert on public.operational_target_progress_updates for insert to authenticated
  with check (public.is_admin());
create policy admin_update on public.operational_targets for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.operational_targets to authenticated;
grant select, insert on public.operational_target_progress_updates to authenticated;
revoke all on function public.prevent_active_target_definition_mutation() from public;
revoke all on function public.require_active_operational_target() from public;
