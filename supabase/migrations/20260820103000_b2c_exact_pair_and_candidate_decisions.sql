-- First-import candidates are automatically confirmed only through the same
-- audited decision path an Admin uses. This removes the former parallel
-- lineage/link writer, which left permanently pending phantom candidates.
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
    "id" text, "sourceTab" text, "sourceRowNumber" text, "rawPayload" jsonb,
    "reportedDateRaw" text, "declaredMonthRaw" text, "declaredYearRaw" text, "amountUsdRaw" text,
    "customerNameRaw" text, "customerEmailRaw" text, "customerPhoneRaw" text, "categoryRaw" text,
    "membershipTypeRaw" text, "paymentMethodRaw" text, "paymentStatusRaw" text, "noteRaw" text,
    "occurredOn" text, "amountUsd" text, "normalizedCustomerName" text, "normalizedCustomerEmail" text,
    "normalizedCustomerPhone" text, "rowQuality" text, "qualityIssues" jsonb
  );

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
      ) returning id into candidate_id;

      -- The first-ever Payment Tracker import has no prior state to reconcile,
      -- so its unambiguous new identities are automatically confirmed through
      -- the one decision trigger. That trigger creates the lineage and links
      -- every finance_row_id, including an approved B2C/B2C Cons pair.
      if not has_prior_payment_tracker_import and candidate_item ->> 'candidateKind' = 'new' then
        insert into public.b2c_finance_import_version_decisions (
          import_id, candidate_id, decision, reason
        ) values (
          import_id, candidate_id, 'confirm_new',
          'Automatically confirmed: the first Payment Tracker import has no prior version to reconcile against.'
        );
      end if;
    end loop;
  end if;

  update public.b2c_finance_imports
  set import_status = 'completed'
  where id = import_id;

  perform public.create_b2c_exact_duplicate_groups();
  return import_id;
end;
$$;

revoke all on function public.finalize_b2c_finance_import_version(text, text, text, text, uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.finalize_b2c_finance_import_version(text, text, text, text, uuid, jsonb, jsonb, jsonb) to authenticated;

-- Earlier first-import candidates were linked directly with link_kind =
-- 'initial'. Backfill their missing decision only when that immutable lineage
-- evidence proves the original automatic outcome. Any inconsistent candidate
-- aborts this migration rather than inventing a financial decision.
do $$
declare
  unsafe_candidate_id uuid;
begin
  select candidates.id into unsafe_candidate_id
  from public.b2c_finance_import_version_candidates candidates
  join public.b2c_finance_imports imports on imports.id = candidates.import_id
  where imports.source_kind = 'payment_tracker'
    and imports.supersedes_import_id is null
    and candidates.candidate_kind = 'new'
    and not exists (
      select 1 from public.b2c_finance_import_version_decisions decisions
      where decisions.candidate_id = candidates.id
    )
    and (
      exists (
        select 1
        from unnest(candidates.finance_row_ids) as candidate_row_id
        left join public.b2c_finance_row_lineage_links links on links.finance_row_id = candidate_row_id
        where links.finance_row_id is null or links.link_kind <> 'initial'
      )
      or 1 <> (
        select count(distinct links.lineage_id)
        from unnest(candidates.finance_row_ids) as candidate_row_id
        join public.b2c_finance_row_lineage_links links on links.finance_row_id = candidate_row_id
      )
    )
  limit 1;

  if unsafe_candidate_id is not null then
    raise exception 'Cannot safely backfill the automatic B2C Finance decision for candidate %', unsafe_candidate_id;
  end if;

  alter table public.b2c_finance_import_version_decisions disable trigger apply_b2c_finance_import_version_decision;

  insert into public.b2c_finance_import_version_decisions (
    import_id, candidate_id, decision, reason, decided_by
  )
  select
    candidates.import_id,
    candidates.id,
    'confirm_new',
    'Backfilled automatic confirmation: this first Payment Tracker import was already linked through the original initial-link path.',
    imports.imported_by
  from public.b2c_finance_import_version_candidates candidates
  join public.b2c_finance_imports imports on imports.id = candidates.import_id
  where imports.source_kind = 'payment_tracker'
    and imports.supersedes_import_id is null
    and candidates.candidate_kind = 'new'
    and not exists (
      select 1 from public.b2c_finance_import_version_decisions decisions
      where decisions.candidate_id = candidates.id
    );

  alter table public.b2c_finance_import_version_decisions enable trigger apply_b2c_finance_import_version_decision;
end;
$$;
