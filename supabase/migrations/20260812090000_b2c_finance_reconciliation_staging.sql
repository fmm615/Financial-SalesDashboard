-- B2C Finance reconciliation is a staged, Admin-only workflow. The Finance
-- workbook provides revenue candidates; Stripe and Tap provide payment evidence.
-- Nothing in this migration writes to b2c_payments or a reportable view.

create type public.b2c_finance_import_source_kind as enum (
  'payment_tracker',
  'tap_statement',
  'stripe_charges'
);

create type public.b2c_finance_import_status as enum (
  'pending',
  'processing',
  'completed',
  'failed'
);

create type public.b2c_finance_row_quality as enum (
  'valid',
  'zero_value',
  'needs_review',
  'invalid'
);

create type public.b2c_reconciliation_state as enum (
  'unmatched',
  'exact_duplicate_candidate',
  'possible_duplicate',
  'conflict',
  'canonical',
  'excluded'
);

create type public.b2c_provider_evidence_kind as enum (
  'sale',
  'processing_fee',
  'fee_vat',
  'refund',
  'transfer',
  'opening_balance',
  'needs_review'
);

create table public.b2c_finance_imports (
  id uuid primary key default gen_random_uuid(),
  source_kind public.b2c_finance_import_source_kind not null,
  source_file_name text not null check (char_length(trim(source_file_name)) between 1 and 255),
  source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  source_storage_bucket text not null check (char_length(trim(source_storage_bucket)) between 1 and 100),
  source_storage_path text not null check (char_length(trim(source_storage_path)) between 1 and 1000),
  import_status public.b2c_finance_import_status not null default 'pending',
  safe_error_summary text check (safe_error_summary is null or char_length(trim(safe_error_summary)) between 1 and 1000),
  imported_by uuid not null references public.profiles(id),
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (source_file_sha256),
  check (
    (import_status = 'completed' and completed_at is not null and failed_at is null and safe_error_summary is null)
    or (import_status = 'failed' and failed_at is not null and completed_at is null and safe_error_summary is not null)
    or (import_status in ('pending', 'processing') and completed_at is null and failed_at is null)
  )
);

create table public.b2c_finance_staging_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.b2c_finance_imports(id),
  source_tab text not null check (source_tab in ('B2C', 'B2C Cons')),
  source_row_number integer not null check (source_row_number >= 2),
  raw_payload jsonb not null check (jsonb_typeof(raw_payload) = 'object'),
  reported_date_raw text not null check (char_length(trim(reported_date_raw)) between 1 and 100),
  declared_month_raw text,
  declared_year_raw text,
  amount_usd_raw text,
  customer_name_raw text,
  customer_email_raw text,
  customer_phone_raw text,
  category_raw text,
  membership_type_raw text,
  payment_method_raw text,
  payment_status_raw text,
  note_raw text,
  occurred_on date,
  amount_usd numeric(20, 6) check (amount_usd is null or amount_usd >= 0),
  normalized_customer_name text,
  normalized_customer_email citext,
  normalized_customer_phone text,
  row_quality public.b2c_finance_row_quality not null,
  quality_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(quality_issues) = 'array'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (import_id, source_tab, source_row_number)
);

create table public.b2c_provider_evidence (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.b2c_finance_imports(id),
  provider text not null check (provider in ('tap', 'stripe')),
  source_row_number integer not null check (source_row_number >= 2),
  provider_row_id text,
  provider_payment_id text,
  provider_refund_id text,
  transaction_kind public.b2c_provider_evidence_kind not null check (transaction_kind in ('sale', 'processing_fee', 'fee_vat', 'refund', 'transfer', 'opening_balance', 'needs_review')),
  description_raw text,
  occurred_at timestamptz,
  occurred_at_raw text,
  original_currency text not null check (original_currency ~ '^[A-Z]{3}$'),
  credit_amount numeric(20, 6) check (credit_amount is null or credit_amount >= 0),
  debit_amount numeric(20, 6) check (debit_amount is null or debit_amount >= 0),
  raw_payload jsonb not null check (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (import_id, source_row_number),
  unique (provider, provider_row_id),
  check (transaction_kind <> 'sale' or provider_payment_id is not null),
  check (transaction_kind <> 'refund' or provider_refund_id is not null)
);

create table public.b2c_reconciliation_groups (
  id uuid primary key default gen_random_uuid(),
  reconciliation_state public.b2c_reconciliation_state not null default 'unmatched'
    check (reconciliation_state in ('unmatched', 'exact_duplicate_candidate', 'possible_duplicate', 'conflict', 'canonical', 'excluded')),
  canonical_finance_row_id uuid references public.b2c_finance_staging_rows(id),
  decision_reason text,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (reconciliation_state in ('canonical', 'excluded') and decided_by is not null and decided_at is not null and char_length(trim(coalesce(decision_reason, ''))) > 0)
    or (reconciliation_state not in ('canonical', 'excluded') and canonical_finance_row_id is null and decision_reason is null and decided_by is null and decided_at is null)
  ),
  check (
    (reconciliation_state = 'canonical' and canonical_finance_row_id is not null)
    or (reconciliation_state <> 'canonical' and canonical_finance_row_id is null)
  )
);

create table public.b2c_reconciliation_finance_rows (
  id uuid primary key default gen_random_uuid(),
  reconciliation_group_id uuid not null references public.b2c_reconciliation_groups(id),
  finance_row_id uuid not null unique references public.b2c_finance_staging_rows(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (reconciliation_group_id, finance_row_id)
);

create table public.b2c_reconciliation_provider_evidence (
  id uuid primary key default gen_random_uuid(),
  reconciliation_group_id uuid not null references public.b2c_reconciliation_groups(id),
  provider_evidence_id uuid not null unique references public.b2c_provider_evidence(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (reconciliation_group_id, provider_evidence_id)
);

create table public.b2c_reconciliation_decisions (
  id uuid primary key default gen_random_uuid(),
  reconciliation_group_id uuid not null unique references public.b2c_reconciliation_groups(id),
  decision_state public.b2c_reconciliation_state not null check (decision_state in ('canonical', 'excluded')),
  canonical_finance_row_id uuid references public.b2c_finance_staging_rows(id),
  decision_reason text not null check (char_length(trim(decision_reason)) between 1 and 1000),
  decided_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (decision_state = 'canonical' and canonical_finance_row_id is not null)
    or (decision_state = 'excluded' and canonical_finance_row_id is null)
  )
);

create index b2c_finance_imports_status_created_idx
  on public.b2c_finance_imports (source_kind, import_status, created_at desc);
create index b2c_finance_staging_rows_comparison_idx
  on public.b2c_finance_staging_rows (normalized_customer_email, occurred_on, amount_usd)
  where normalized_customer_email is not null and occurred_on is not null and amount_usd is not null;
create index b2c_finance_staging_rows_name_comparison_idx
  on public.b2c_finance_staging_rows (normalized_customer_name, payment_method_raw, occurred_on, amount_usd)
  where normalized_customer_name is not null and payment_method_raw is not null and occurred_on is not null and amount_usd is not null;
create index b2c_finance_staging_rows_quality_idx
  on public.b2c_finance_staging_rows (row_quality, import_id);
create index b2c_provider_evidence_payment_idx
  on public.b2c_provider_evidence (provider, provider_payment_id)
  where provider_payment_id is not null;
create index b2c_reconciliation_groups_state_idx
  on public.b2c_reconciliation_groups (reconciliation_state, created_at desc);

create or replace function public.assign_b2c_reconciliation_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'B2C reconciliation entries require an authenticated administrator';
  end if;

  if tg_table_name = 'b2c_finance_imports' then
    if tg_op = 'INSERT' then
      new.imported_by := auth.uid();
    elsif new.imported_by is distinct from old.imported_by then
      raise exception 'B2C import actor cannot be changed';
    end if;
  elsif tg_table_name = 'b2c_reconciliation_groups' then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    elsif new.created_by is distinct from old.created_by then
      raise exception 'B2C reconciliation group actor cannot be changed';
    end if;
  elsif tg_table_name = 'b2c_reconciliation_decisions' then
    new.decided_by := auth.uid();
  end if;

  return new;
end;
$$;

create or replace function public.set_b2c_finance_import_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_kind is distinct from old.source_kind
    or new.source_file_name is distinct from old.source_file_name
    or new.source_file_sha256 is distinct from old.source_file_sha256
    or new.source_storage_bucket is distinct from old.source_storage_bucket
    or new.source_storage_path is distinct from old.source_storage_path
    or new.created_at is distinct from old.created_at then
    raise exception 'B2C import source provenance is immutable';
  end if;

  if old.import_status in ('completed', 'failed') and new.import_status <> old.import_status then
    raise exception 'Completed or failed B2C imports cannot be reopened';
  end if;
  if old.import_status = 'pending' and new.import_status not in ('pending', 'processing', 'failed') then
    raise exception 'Pending B2C imports must begin processing before completion';
  end if;
  if old.import_status = 'processing' and new.import_status not in ('processing', 'completed', 'failed') then
    raise exception 'Processing B2C imports can only complete or fail';
  end if;

  new.updated_at := timezone('utc', now());
  if new.import_status = 'completed' and old.import_status <> 'completed' then
    new.completed_at := timezone('utc', now());
    new.failed_at := null;
    new.safe_error_summary := null;
  elsif new.import_status = 'failed' and old.import_status <> 'failed' then
    new.failed_at := timezone('utc', now());
    new.completed_at := null;
  elsif new.import_status = 'completed' then
    new.safe_error_summary := null;
  end if;
  return new;
end;
$$;

create or replace function public.require_b2c_reconciliation_import_source()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  import_source_kind public.b2c_finance_import_source_kind;
begin
  select source_kind into import_source_kind
  from public.b2c_finance_imports
  where id = new.import_id
  for key share;

  if not found then
    raise exception 'B2C reconciliation import does not exist';
  end if;

  if tg_table_name = 'b2c_finance_staging_rows' and import_source_kind <> 'payment_tracker' then
    raise exception 'Finance staging rows require a Payment Tracker import';
  end if;

  if tg_table_name = 'b2c_provider_evidence' then
    if import_source_kind = 'tap_statement' and new.provider <> 'tap' then
      raise exception 'Tap statement imports can only contain Tap evidence';
    elsif import_source_kind = 'stripe_charges' and new.provider <> 'stripe' then
      raise exception 'Stripe Charges imports can only contain Stripe evidence';
    elsif import_source_kind not in ('tap_statement', 'stripe_charges') then
      raise exception 'Provider evidence requires a Tap or Stripe import';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.apply_b2c_reconciliation_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_state public.b2c_reconciliation_state;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can decide B2C reconciliation groups';
  end if;

  select reconciliation_state into existing_state
  from public.b2c_reconciliation_groups
  where id = new.reconciliation_group_id
  for update;

  if not found then
    raise exception 'B2C reconciliation group does not exist';
  end if;

  if existing_state in ('canonical', 'excluded') then
    raise exception 'A B2C reconciliation group can only be decided once';
  end if;

  if new.decision_state = 'canonical' and not exists (
    select 1
    from public.b2c_reconciliation_finance_rows
    where reconciliation_group_id = new.reconciliation_group_id
      and finance_row_id = new.canonical_finance_row_id
  ) then
    raise exception 'The canonical Finance row must belong to the reconciliation group';
  end if;

  new.decided_by := auth.uid();

  update public.b2c_reconciliation_groups
  set reconciliation_state = new.decision_state,
      canonical_finance_row_id = new.canonical_finance_row_id,
      decision_reason = new.decision_reason,
      decided_by = auth.uid(),
      decided_at = timezone('utc', now())
  where id = new.reconciliation_group_id;

  return new;
end;
$$;

create trigger assign_b2c_finance_import_actor before insert or update on public.b2c_finance_imports
  for each row execute procedure public.assign_b2c_reconciliation_actor();
create trigger set_b2c_finance_import_updated_at before update on public.b2c_finance_imports
  for each row execute procedure public.set_b2c_finance_import_updated_at();
create trigger require_b2c_finance_staging_import before insert on public.b2c_finance_staging_rows
  for each row execute procedure public.require_b2c_reconciliation_import_source();
create trigger require_b2c_provider_evidence_import before insert on public.b2c_provider_evidence
  for each row execute procedure public.require_b2c_reconciliation_import_source();
create trigger assign_b2c_reconciliation_group_actor before insert or update on public.b2c_reconciliation_groups
  for each row execute procedure public.assign_b2c_reconciliation_actor();
create trigger apply_b2c_reconciliation_decision before insert on public.b2c_reconciliation_decisions
  for each row execute procedure public.apply_b2c_reconciliation_decision();

do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'b2c_finance_imports',
    'b2c_finance_staging_rows',
    'b2c_provider_evidence',
    'b2c_reconciliation_groups',
    'b2c_reconciliation_finance_rows',
    'b2c_reconciliation_provider_evidence',
    'b2c_reconciliation_decisions'
  ] loop
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute procedure public.write_audit_event()',
      audited_table
    );
  end loop;
end;
$$;

alter table public.b2c_finance_imports enable row level security;
alter table public.b2c_finance_staging_rows enable row level security;
alter table public.b2c_provider_evidence enable row level security;
alter table public.b2c_reconciliation_groups enable row level security;
alter table public.b2c_reconciliation_finance_rows enable row level security;
alter table public.b2c_reconciliation_provider_evidence enable row level security;
alter table public.b2c_reconciliation_decisions enable row level security;

do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'b2c_finance_imports',
    'b2c_finance_staging_rows',
    'b2c_provider_evidence',
    'b2c_reconciliation_groups',
    'b2c_reconciliation_finance_rows',
    'b2c_reconciliation_provider_evidence',
    'b2c_reconciliation_decisions'
  ] loop
    execute format(
      'create policy admin_read on public.%I for select to authenticated using (public.is_admin())',
      protected_table
    );
    execute format(
      'create policy admin_insert on public.%I for insert to authenticated with check (public.is_admin())',
      protected_table
    );
  end loop;
end;
$$;

create policy admin_update_import_state on public.b2c_finance_imports for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.b2c_finance_imports to authenticated;
grant select, insert on public.b2c_finance_staging_rows to authenticated;
grant select, insert on public.b2c_provider_evidence to authenticated;
grant select, insert on public.b2c_reconciliation_groups to authenticated;
grant select, insert on public.b2c_reconciliation_finance_rows to authenticated;
grant select, insert on public.b2c_reconciliation_provider_evidence to authenticated;
grant select, insert on public.b2c_reconciliation_decisions to authenticated;

revoke all on function public.assign_b2c_reconciliation_actor() from public;
revoke all on function public.set_b2c_finance_import_updated_at() from public;
revoke all on function public.require_b2c_reconciliation_import_source() from public;
revoke all on function public.apply_b2c_reconciliation_decision() from public;
