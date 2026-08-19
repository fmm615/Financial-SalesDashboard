-- A replacement Payment Tracker workbook must never repost a payment that a
-- prior import already staged. Every Finance staging row is linked to a
-- stable, content-derived "lineage" identity; the same real payment keeps the
-- same lineage across every re-upload, so posting (Task 2) can be idempotent
-- per lineage instead of per staging row.

-- Approximates (does not perfectly replicate) the JS NFKD canonicalization used
-- for every workbook row's identity, so a manual bank transfer's reserved
-- identity still matches an accented-name workbook row for the same payment.
create extension if not exists unaccent;

alter table public.b2c_finance_imports
  add column supersedes_import_id uuid references public.b2c_finance_imports(id);

alter table public.b2c_finance_imports
  add constraint b2c_finance_imports_supersedes_import_id_unique unique (supersedes_import_id);

create index b2c_finance_imports_supersedes_import_id_idx
  on public.b2c_finance_imports (supersedes_import_id)
  where supersedes_import_id is not null;

create table public.b2c_finance_record_lineages (
  id uuid primary key default gen_random_uuid(),
  source_identity char(64) not null,
  represented_payment_id uuid unique references public.b2c_payments(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_identity)
);

create table public.b2c_finance_row_lineage_links (
  finance_row_id uuid primary key references public.b2c_finance_staging_rows(id),
  lineage_id uuid not null references public.b2c_finance_record_lineages(id),
  link_kind text not null check (link_kind in ('initial', 'unchanged_version', 'admin_confirmed_new', 'admin_confirmed_revision', 'admin_linked_existing_manual')),
  linked_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.b2c_finance_import_version_candidates (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.b2c_finance_imports(id),
  candidate_kind text not null check (candidate_kind in ('new', 'removed', 'ambiguous', 'existing_payment')),
  source_identity char(64) not null,
  finance_row_ids uuid[] not null check (cardinality(finance_row_ids) > 0),
  prior_lineage_ids uuid[] not null default '{}',
  prior_payment_ids uuid[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  unique (import_id, candidate_kind, source_identity)
);

create table public.b2c_finance_import_version_decisions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.b2c_finance_imports(id),
  candidate_id uuid not null references public.b2c_finance_import_version_candidates(id),
  decision text not null check (decision in ('confirm_new', 'link_revision', 'link_existing_manual')),
  target_lineage_id uuid references public.b2c_finance_record_lineages(id),
  target_payment_id uuid references public.b2c_payments(id),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  decided_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (import_id, candidate_id),
  check (
    (decision = 'confirm_new' and target_lineage_id is null and target_payment_id is null)
    or (decision = 'link_revision' and target_lineage_id is not null and target_payment_id is null)
    or (decision = 'link_existing_manual' and target_lineage_id is null and target_payment_id is not null)
  )
);

create index b2c_finance_row_lineage_links_lineage_id_idx
  on public.b2c_finance_row_lineage_links (lineage_id);
create index b2c_finance_import_version_candidates_import_kind_idx
  on public.b2c_finance_import_version_candidates (import_id, candidate_kind);
create index b2c_finance_import_version_decisions_import_id_idx
  on public.b2c_finance_import_version_decisions (import_id);

-- Every lineage-affecting row records who acted; none of this is client-supplied.
create or replace function public.assign_b2c_finance_lineage_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'B2C Finance lineage entries require an authenticated administrator';
  end if;

  if tg_table_name = 'b2c_finance_record_lineages' then
    new.created_by := auth.uid();
  elsif tg_table_name = 'b2c_finance_row_lineage_links' then
    new.linked_by := auth.uid();
  end if;

  return new;
end;
$$;

create trigger assign_b2c_finance_record_lineage_actor before insert on public.b2c_finance_record_lineages
  for each row execute procedure public.assign_b2c_finance_lineage_actor();
create trigger assign_b2c_finance_row_lineage_link_actor before insert on public.b2c_finance_row_lineage_links
  for each row execute procedure public.assign_b2c_finance_lineage_actor();

-- A lineage link is a permanent audit fact: once a Finance row is linked to a
-- lineage, the link can never be repointed or removed.
create or replace function public.prevent_b2c_finance_lineage_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% is immutable', tg_table_name;
end;
$$;

create trigger prevent_b2c_finance_row_lineage_link_mutation
  before update or delete on public.b2c_finance_row_lineage_links
  for each row execute procedure public.prevent_b2c_finance_lineage_mutation();
create trigger prevent_b2c_finance_import_version_candidate_mutation
  before update or delete on public.b2c_finance_import_version_candidates
  for each row execute procedure public.prevent_b2c_finance_lineage_mutation();
create trigger prevent_b2c_finance_import_version_decision_mutation
  before update or delete on public.b2c_finance_import_version_decisions
  for each row execute procedure public.prevent_b2c_finance_lineage_mutation();

do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'b2c_finance_record_lineages',
    'b2c_finance_row_lineage_links',
    'b2c_finance_import_version_candidates',
    'b2c_finance_import_version_decisions'
  ] loop
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute procedure public.write_audit_event()',
      audited_table
    );
  end loop;
end;
$$;

alter table public.b2c_finance_record_lineages enable row level security;
alter table public.b2c_finance_row_lineage_links enable row level security;
alter table public.b2c_finance_import_version_candidates enable row level security;
alter table public.b2c_finance_import_version_decisions enable row level security;

-- Lineages, links, and candidates are only ever written by the protected
-- finalize/reservation/decision functions below; approved Admins may read them.
create policy admin_read on public.b2c_finance_record_lineages for select to authenticated using (public.is_admin());
create policy admin_read on public.b2c_finance_row_lineage_links for select to authenticated using (public.is_admin());
create policy admin_read on public.b2c_finance_import_version_candidates for select to authenticated using (public.is_admin());

-- A lineage decision is the one Finance write an Admin makes directly; the
-- trigger below locks the candidate and performs the resulting link/lineage insert.
create policy admin_read on public.b2c_finance_import_version_decisions for select to authenticated using (public.is_admin());
create policy admin_insert on public.b2c_finance_import_version_decisions for insert to authenticated with check (public.is_admin());

revoke all on public.b2c_finance_record_lineages from public, anon, authenticated;
revoke all on public.b2c_finance_row_lineage_links from public, anon, authenticated;
revoke all on public.b2c_finance_import_version_candidates from public, anon, authenticated;
revoke all on public.b2c_finance_import_version_decisions from public, anon, authenticated;
grant select on public.b2c_finance_record_lineages to authenticated;
grant select on public.b2c_finance_row_lineage_links to authenticated;
grant select on public.b2c_finance_import_version_candidates to authenticated;
grant select, insert on public.b2c_finance_import_version_decisions to authenticated;

-- A manual bank transfer reserves its payment identity so a later Payment
-- Tracker row for the same real transfer can only be linked as evidence, never
-- reposted as a second payment. Never invent an identity from incomplete data.
create or replace function public.reserve_b2c_finance_manual_bank_transfer_lineage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  canonical_name text;
  identity_text text;
  identity_hash char(64);
begin
  if new.source_system <> 'manual_bank_transfer' then
    return new;
  end if;

  canonical_name := lower(public.unaccent(trim(regexp_replace(coalesce(new.customer_name, ''), '\s+', ' ', 'g'))));
  if canonical_name = ''
    or new.occurred_on is null
    or new.occurred_on in ('infinity'::date, '-infinity'::date)
    or new.amount_usd is null
    or new.amount_usd in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    return new;
  end if;

  identity_text := canonical_name || ' ' || to_char(new.occurred_on, 'YYYY-MM-DD') || ' ' || new.amount_usd::text || ' bank transfer';
  identity_hash := encode(digest(identity_text, 'sha256'), 'hex');

  insert into public.b2c_finance_record_lineages (source_identity, represented_payment_id)
  values (identity_hash, new.id)
  on conflict do nothing;

  return new;
end;
$$;

create trigger reserve_b2c_finance_manual_bank_transfer_lineage
  after insert on public.b2c_payments
  for each row execute procedure public.reserve_b2c_finance_manual_bank_transfer_lineage();

revoke all on function public.assign_b2c_finance_lineage_actor() from public;
revoke all on function public.prevent_b2c_finance_lineage_mutation() from public;
revoke all on function public.reserve_b2c_finance_manual_bank_transfer_lineage() from public;

-- Replaces public.finalize_b2c_finance_import: every Payment Tracker import
-- after the first must declare which completed import it supersedes, and the
-- safe version-diff candidates are persisted in the same transaction as the
-- staged rows. A replacement import never auto-links a new, ambiguous, or
-- existing-payment identity; only rows unchanged from the prior import and the
-- first-ever import's unambiguous new identities receive an automatic lineage.
create or replace function public.finalize_b2c_finance_import_version(
  p_source_file_name text,
  p_source_file_sha256 text,
  p_source_storage_bucket text,
  p_source_storage_path text,
  p_supersedes_import_id uuid,
  p_rows jsonb,
  p_unchanged jsonb,
  p_candidates jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  import_id uuid;
  row_item jsonb;
  row_number_text text;
  has_prior_payment_tracker_import boolean;
  match_item jsonb;
  candidate_item jsonb;
  candidate_id uuid;
  new_lineage_id uuid;
  linked_row_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can finalize B2C Finance imports';
  end if;

  if char_length(trim(coalesce(p_source_file_name, ''))) not between 1 and 255
    or coalesce(p_source_file_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(trim(coalesce(p_source_storage_bucket, ''))) not between 1 and 100
    or char_length(trim(coalesce(p_source_storage_path, ''))) not between 1 and 1000 then
    raise exception 'B2C Finance import provenance is invalid';
  end if;

  select exists (
    select 1 from public.b2c_finance_imports
    where source_kind = 'payment_tracker' and import_status = 'completed'
  ) into has_prior_payment_tracker_import;

  if has_prior_payment_tracker_import and p_supersedes_import_id is null then
    raise exception 'A replacement Payment Tracker import must declare the completed import it supersedes';
  end if;

  if p_supersedes_import_id is not null and not exists (
    select 1 from public.b2c_finance_imports
    where id = p_supersedes_import_id and source_kind = 'payment_tracker' and import_status = 'completed'
  ) then
    raise exception 'The declared prior B2C Finance import is not a completed Payment Tracker import';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'B2C Finance imports require between 1 and 20000 staged rows';
  end if;

  for row_item in select value from jsonb_array_elements(p_rows)
  loop
    row_number_text := coalesce(row_item ->> 'sourceRowNumber', '');
    if coalesce(jsonb_typeof(row_item), '') <> 'object'
      or coalesce(row_item ->> 'id', '') !~ '^[0-9a-fA-F-]{36}$'
      or coalesce(row_item ->> 'sourceTab', '') not in ('B2C', 'B2C Cons')
      or row_number_text !~ '^[0-9]+$'
      or row_number_text::integer < 2
      or coalesce(jsonb_typeof(row_item -> 'rawPayload'), '') <> 'object'
      or char_length(trim(coalesce(row_item ->> 'reportedDateRaw', ''))) not between 1 and 100
      or coalesce(row_item ->> 'rowQuality', '') not in ('valid', 'zero_value', 'needs_review', 'invalid')
      or (nullif(row_item ->> 'amountUsd', '') is not null and row_item ->> 'amountUsd' !~ '^[0-9]+(\.[0-9]{1,6})?$')
      or (nullif(row_item ->> 'occurredOn', '') is not null and row_item ->> 'occurredOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or coalesce(jsonb_typeof(coalesce(row_item -> 'qualityIssues', '[]'::jsonb)), '') <> 'array' then
      raise exception 'B2C Finance staged row is invalid';
    end if;
  end loop;

  insert into public.b2c_finance_imports (
    source_kind, source_file_name, source_file_sha256, source_storage_bucket, source_storage_path, import_status, supersedes_import_id
  ) values (
    'payment_tracker', trim(p_source_file_name), p_source_file_sha256, trim(p_source_storage_bucket), trim(p_source_storage_path), 'processing', p_supersedes_import_id
  ) returning id into import_id;

  insert into public.b2c_finance_staging_rows (
    id, import_id, source_tab, source_row_number, raw_payload, reported_date_raw, declared_month_raw, declared_year_raw,
    amount_usd_raw, customer_name_raw, customer_email_raw, customer_phone_raw, category_raw, membership_type_raw,
    payment_method_raw, payment_status_raw, note_raw, occurred_on, amount_usd, normalized_customer_name,
    normalized_customer_email, normalized_customer_phone, row_quality, quality_issues
  )
  select
    row_data."id"::uuid,
    import_id,
    row_data."sourceTab",
    row_data."sourceRowNumber"::integer,
    row_data."rawPayload",
    row_data."reportedDateRaw",
    nullif(row_data."declaredMonthRaw", ''),
    nullif(row_data."declaredYearRaw", ''),
    nullif(row_data."amountUsdRaw", ''),
    nullif(row_data."customerNameRaw", ''),
    nullif(row_data."customerEmailRaw", ''),
    nullif(row_data."customerPhoneRaw", ''),
    nullif(row_data."categoryRaw", ''),
    nullif(row_data."membershipTypeRaw", ''),
    nullif(row_data."paymentMethodRaw", ''),
    nullif(row_data."paymentStatusRaw", ''),
    nullif(row_data."noteRaw", ''),
    nullif(row_data."occurredOn", '')::date,
    nullif(row_data."amountUsd", '')::numeric(20, 6),
    nullif(row_data."normalizedCustomerName", ''),
    nullif(row_data."normalizedCustomerEmail", '')::citext,
    nullif(row_data."normalizedCustomerPhone", ''),
    row_data."rowQuality"::public.b2c_finance_row_quality,
    coalesce(row_data."qualityIssues", '[]'::jsonb)
  from jsonb_to_recordset(p_rows) as row_data(
    "id" text,
    "sourceTab" text,
    "sourceRowNumber" text,
    "rawPayload" jsonb,
    "reportedDateRaw" text,
    "declaredMonthRaw" text,
    "declaredYearRaw" text,
    "amountUsdRaw" text,
    "customerNameRaw" text,
    "customerEmailRaw" text,
    "customerPhoneRaw" text,
    "categoryRaw" text,
    "membershipTypeRaw" text,
    "paymentMethodRaw" text,
    "paymentStatusRaw" text,
    "noteRaw" text,
    "occurredOn" text,
    "amountUsd" text,
    "normalizedCustomerName" text,
    "normalizedCustomerEmail" text,
    "normalizedCustomerPhone" text,
    "rowQuality" text,
    "qualityIssues" jsonb
  );

  -- Rows unchanged from the prior import link straight to their existing lineage.
  if p_unchanged is not null and jsonb_typeof(p_unchanged) = 'array' then
    for match_item in select value from jsonb_array_elements(p_unchanged)
    loop
      if coalesce(match_item ->> 'financeRowId', '') !~ '^[0-9a-fA-F-]{36}$'
        or coalesce(match_item ->> 'lineageId', '') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception 'B2C Finance unchanged row match is invalid';
      end if;
      insert into public.b2c_finance_row_lineage_links (finance_row_id, lineage_id, link_kind)
      values ((match_item ->> 'financeRowId')::uuid, (match_item ->> 'lineageId')::uuid, 'unchanged_version');
    end loop;
  end if;

  -- The remaining safe diff candidates are always persisted for Admin review.
  if p_candidates is not null and jsonb_typeof(p_candidates) = 'array' then
    for candidate_item in select value from jsonb_array_elements(p_candidates)
    loop
      if coalesce(candidate_item ->> 'candidateKind', '') not in ('new', 'removed', 'ambiguous', 'existing_payment')
        or coalesce(jsonb_typeof(candidate_item -> 'financeRowIds'), '') <> 'array'
        or jsonb_array_length(candidate_item -> 'financeRowIds') = 0
        or coalesce(candidate_item ->> 'sourceIdentity', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'B2C Finance import version candidate is invalid';
      end if;

      insert into public.b2c_finance_import_version_candidates (
        import_id, candidate_kind, source_identity, finance_row_ids, prior_lineage_ids, prior_payment_ids
      ) values (
        import_id,
        candidate_item ->> 'candidateKind',
        candidate_item ->> 'sourceIdentity',
        array(select jsonb_array_elements_text(candidate_item -> 'financeRowIds'))::uuid[],
        array(select jsonb_array_elements_text(coalesce(candidate_item -> 'priorLineageIds', '[]'::jsonb)))::uuid[],
        array(select jsonb_array_elements_text(coalesce(candidate_item -> 'priorPaymentIds', '[]'::jsonb)))::uuid[]
      )
      returning id into candidate_id;

      -- The first-ever Payment Tracker import has no prior state to reconcile:
      -- its unambiguous new identities are confirmed automatically.
      if not has_prior_payment_tracker_import and candidate_item ->> 'candidateKind' = 'new' then
        insert into public.b2c_finance_record_lineages (source_identity)
        values (candidate_item ->> 'sourceIdentity')
        on conflict (source_identity) do update set source_identity = excluded.source_identity
        returning id into new_lineage_id;

        for linked_row_id in select (jsonb_array_elements_text(candidate_item -> 'financeRowIds'))::uuid
        loop
          insert into public.b2c_finance_row_lineage_links (finance_row_id, lineage_id, link_kind)
          values (linked_row_id, new_lineage_id, 'initial');
        end loop;
      end if;
    end loop;
  end if;

  update public.b2c_finance_imports
  set import_status = 'completed'
  where id = import_id;

  -- Exact cross-tab B2C/B2C Cons candidate groups are created as part of this
  -- transaction; the Admin never runs a second discovery action.
  perform public.create_b2c_exact_duplicate_groups();

  return import_id;
end;
$$;

revoke all on function public.finalize_b2c_finance_import_version(text, text, text, text, uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.finalize_b2c_finance_import_version(text, text, text, text, uuid, jsonb, jsonb, jsonb) to authenticated;

-- An Admin's confirm_new / link_revision / link_existing_manual decision is
-- the only direct client write; this trigger locks the candidate, rejects a
-- second conflicting decision, and performs the resulting lineage link.
create or replace function public.apply_b2c_finance_import_version_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_candidate public.b2c_finance_import_version_candidates%rowtype;
  linked_row_id uuid;
  resolved_lineage_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can decide a B2C Finance import version candidate';
  end if;

  select * into target_candidate
  from public.b2c_finance_import_version_candidates
  where id = new.candidate_id
  for update;

  if not found then
    raise exception 'The B2C Finance import version candidate does not exist';
  end if;

  if new.import_id is distinct from target_candidate.import_id then
    raise exception 'The decision import does not match the candidate import';
  end if;

  if exists (
    select 1 from public.b2c_finance_import_version_decisions
    where candidate_id = new.candidate_id
  ) then
    raise exception 'This B2C Finance import version candidate already has a decision';
  end if;

  if exists (
    select 1 from public.b2c_finance_row_lineage_links
    where finance_row_id = any(target_candidate.finance_row_ids)
  ) then
    raise exception 'A row in this candidate is already linked to a B2C Finance lineage';
  end if;

  if new.decision = 'confirm_new' then
    if target_candidate.candidate_kind <> 'new' then
      raise exception 'Only a new candidate can be confirmed as a new B2C Finance lineage';
    end if;

    insert into public.b2c_finance_record_lineages (source_identity)
    values (target_candidate.source_identity)
    returning id into resolved_lineage_id;

    foreach linked_row_id in array target_candidate.finance_row_ids loop
      insert into public.b2c_finance_row_lineage_links (finance_row_id, lineage_id, link_kind)
      values (linked_row_id, resolved_lineage_id, 'admin_confirmed_new');
    end loop;

  elsif new.decision = 'link_revision' then
    if target_candidate.candidate_kind not in ('new', 'ambiguous') then
      raise exception 'Only a new or ambiguous candidate can link to a prior B2C Finance lineage';
    end if;
    if new.target_lineage_id is null or not exists (
      select 1 from public.b2c_finance_record_lineages where id = new.target_lineage_id
    ) then
      raise exception 'The target B2C Finance lineage does not exist';
    end if;

    foreach linked_row_id in array target_candidate.finance_row_ids loop
      insert into public.b2c_finance_row_lineage_links (finance_row_id, lineage_id, link_kind)
      values (linked_row_id, new.target_lineage_id, 'admin_confirmed_revision');
    end loop;

  elsif new.decision = 'link_existing_manual' then
    if target_candidate.candidate_kind not in ('existing_payment', 'ambiguous') then
      raise exception 'Only an existing-payment or ambiguous candidate can link to a manual B2C payment';
    end if;
    if new.target_payment_id is null then
      raise exception 'A target payment is required to link an existing manual B2C payment';
    end if;

    select lineage.id into resolved_lineage_id
    from public.b2c_finance_record_lineages lineage
    where lineage.represented_payment_id = new.target_payment_id;

    if resolved_lineage_id is null then
      raise exception 'The target payment has no reserved B2C Finance lineage';
    end if;

    foreach linked_row_id in array target_candidate.finance_row_ids loop
      insert into public.b2c_finance_row_lineage_links (finance_row_id, lineage_id, link_kind)
      values (linked_row_id, resolved_lineage_id, 'admin_linked_existing_manual');
    end loop;
  else
    raise exception 'Unrecognised B2C Finance import version decision';
  end if;

  new.decided_by := auth.uid();
  return new;
end;
$$;

create trigger apply_b2c_finance_import_version_decision before insert on public.b2c_finance_import_version_decisions
  for each row execute procedure public.apply_b2c_finance_import_version_decision();

revoke all on function public.apply_b2c_finance_import_version_decision() from public;
