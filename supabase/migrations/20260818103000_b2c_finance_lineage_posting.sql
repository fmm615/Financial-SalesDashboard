-- Approved Finance posting must be idempotent per stable lineage identity, not
-- per raw staging row. Task 1 (b2c_finance_record_lineages,
-- b2c_finance_row_lineage_links) can now link the same real payment across
-- several staging rows from different workbook versions (an `initial` link on
-- the first row, an `unchanged_version` link on a later replacement's
-- matching row, or an `admin_confirmed_revision` link). Without this change,
-- a replacement workbook re-uploading the same payment under a new staging
-- row id would be posted a second time.

-- Step A: add the new column, nullable first so the backfill below can run.
alter table public.b2c_finance_ledger_posts
  add column lineage_id uuid references public.b2c_finance_record_lineages(id);

-- Step B: backfill one lineage (and one 'initial' link) per already-posted
-- row, computing the identity so it exactly matches what
-- createFinanceSourceIdentity() would compute for the same payment if a
-- future replacement workbook re-uploaded it. This is what lets Task 1's
-- version-diff correctly recognize a historical payment as "unchanged"
-- rather than "new" when Finance eventually re-uploads a corrected workbook
-- covering old dates.
--
-- The actor-assignment triggers on b2c_finance_record_lineages and
-- b2c_finance_row_lineage_links raise an exception when auth.uid() is null,
-- which is always true for a migration run outside a request context. They
-- are disabled for the duration of the backfill and re-enabled immediately
-- after; created_by/linked_by are set explicitly to the original posting
-- Admin (posts.posted_by) instead.
alter table public.b2c_finance_record_lineages disable trigger assign_b2c_finance_record_lineage_actor;
alter table public.b2c_finance_row_lineage_links disable trigger assign_b2c_finance_row_lineage_link_actor;

do $$
declare
  post_record record;
  identity_text text;
  identity_hash char(64);
  resolved_lineage_id uuid;
begin
  for post_record in
    select
      posts.id as post_id,
      posts.finance_row_id,
      posts.posted_by,
      rows.normalized_customer_name,
      rows.occurred_on,
      rows.amount_usd,
      rows.payment_method_raw
    from public.b2c_finance_ledger_posts posts
    join public.b2c_finance_staging_rows rows on rows.id = posts.finance_row_id
    where posts.lineage_id is null
  loop
    identity_text :=
      coalesce(post_record.normalized_customer_name, '') || ' ' ||
      to_char(post_record.occurred_on, 'YYYY-MM-DD') || ' ' ||
      post_record.amount_usd::text || ' ' ||
      lower(public.unaccent(trim(regexp_replace(coalesce(post_record.payment_method_raw, ''), '\s+', ' ', 'g'))));
    -- Supabase installs pgcrypto in the extensions schema, so digest() is
    -- schema-qualified here: this anonymous block runs with the migration
    -- session's default search path, not a function-local one.
    identity_hash := encode(extensions.digest(identity_text, 'sha256'), 'hex');

    insert into public.b2c_finance_record_lineages (source_identity, created_by)
    values (identity_hash, post_record.posted_by)
    on conflict (source_identity) do update set source_identity = excluded.source_identity
    returning id into resolved_lineage_id;

    insert into public.b2c_finance_row_lineage_links (finance_row_id, lineage_id, link_kind, linked_by)
    values (post_record.finance_row_id, resolved_lineage_id, 'initial', post_record.posted_by)
    on conflict (finance_row_id) do nothing;

    update public.b2c_finance_ledger_posts
    set lineage_id = resolved_lineage_id
    where id = post_record.post_id;
  end loop;
end;
$$;

alter table public.b2c_finance_record_lineages enable trigger assign_b2c_finance_record_lineage_actor;
alter table public.b2c_finance_row_lineage_links enable trigger assign_b2c_finance_row_lineage_link_actor;

-- Step C: every existing post now has a lineage; enforce the invariant going forward.
alter table public.b2c_finance_ledger_posts
  alter column lineage_id set not null,
  add constraint b2c_finance_ledger_posts_lineage_id_unique unique (lineage_id);

-- Step D: post from the current linked row per confirmed lineage, not from
-- raw staging rows. A lineage represented by an existing manual bank
-- transfer (represented_payment_id is not null) is never eligible for a
-- second, finance_tracker-sourced payment. A lineage that already has a
-- ledger post is safely reported as already posted and never reposted -- an
-- admin-confirmed revision to an already-posted lineage must go through the
-- append-only apply_b2c_finance_posted_adjustment() path instead.
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

  with current_linked_rows as (
    select distinct on (links.lineage_id)
      links.lineage_id,
      links.finance_row_id,
      lineages.represented_payment_id,
      case trim(regexp_replace(lower(coalesce(effective.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g'))
        when 'bank transfer' then 'bank_transfer'
        when 'ios' then 'ios'
      end as finance_payment_method
    from public.b2c_finance_row_lineage_links links
    join public.b2c_finance_record_lineages lineages on lineages.id = links.lineage_id
    join public.b2c_finance_effective_rows effective on effective.id = links.finance_row_id
    join public.b2c_finance_staging_rows source_rows on source_rows.id = links.finance_row_id
    join public.b2c_finance_imports imports on imports.id = source_rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
    order by links.lineage_id, links.created_at desc
  )
  select count(distinct lineage_id) into supported_rows
  from current_linked_rows
  where finance_payment_method is not null;

  with current_linked_rows as (
    select distinct on (links.lineage_id)
      links.lineage_id,
      links.finance_row_id,
      lineages.represented_payment_id,
      case trim(regexp_replace(lower(coalesce(effective.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g'))
        when 'bank transfer' then 'bank_transfer'
        when 'ios' then 'ios'
      end as finance_payment_method
    from public.b2c_finance_row_lineage_links links
    join public.b2c_finance_record_lineages lineages on lineages.id = links.lineage_id
    join public.b2c_finance_effective_rows effective on effective.id = links.finance_row_id
    join public.b2c_finance_staging_rows source_rows on source_rows.id = links.finance_row_id
    join public.b2c_finance_imports imports on imports.id = source_rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
    order by links.lineage_id, links.created_at desc
  )
  select count(distinct rows.lineage_id) into already_posted
  from current_linked_rows rows
  where rows.finance_payment_method is not null
    and exists (
      select 1 from public.b2c_finance_ledger_posts posts where posts.lineage_id = rows.lineage_id
    );

  with current_linked_rows as (
    select distinct on (links.lineage_id)
      links.lineage_id,
      links.finance_row_id,
      lineages.represented_payment_id,
      effective.import_id,
      effective.source_tab,
      effective.source_row_number,
      effective.occurred_on,
      effective.amount_usd,
      effective.source_occurred_on,
      effective.source_amount_usd,
      effective.source_category_raw,
      nullif(trim(effective.customer_name), '') as customer_name,
      nullif(lower(trim(effective.customer_email_raw)), '') as customer_email,
      nullif(trim(effective.customer_phone_raw), '') as customer_phone,
      nullif(trim(effective.membership_type_raw), '') as membership_tier,
      nullif(trim(effective.category_raw), '') as category_raw,
      case trim(regexp_replace(lower(coalesce(effective.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g'))
        when 'bank transfer' then 'bank_transfer'
        when 'ios' then 'ios'
      end as finance_payment_method,
      regexp_replace(
        regexp_replace(lower(trim(coalesce(effective.category_raw, ''))), '[^a-z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      ) as category_code,
      effective.effective_quality
    from public.b2c_finance_row_lineage_links links
    join public.b2c_finance_record_lineages lineages on lineages.id = links.lineage_id
    join public.b2c_finance_effective_rows effective on effective.id = links.finance_row_id
    join public.b2c_finance_staging_rows source_rows on source_rows.id = links.finance_row_id
    join public.b2c_finance_imports imports on imports.id = source_rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
    order by links.lineage_id, links.created_at desc
  ),
  postable_rows as (
    select rows.*
    from current_linked_rows rows
    join public.b2c_finance_staging_rows locked_rows on locked_rows.id = rows.finance_row_id
    where rows.effective_quality = 'valid'
      and rows.amount_usd > 0
      and rows.occurred_on is not null
      and rows.finance_payment_method is not null
      and rows.category_code <> ''
      and rows.represented_payment_id is null
      and not exists (
        select 1 from public.b2c_finance_ledger_posts posts where posts.lineage_id = rows.lineage_id
      )
      and not exists (
        select 1
        from public.b2c_reconciliation_finance_rows group_rows
        join public.b2c_reconciliation_groups groups on groups.id = group_rows.reconciliation_group_id
        where group_rows.finance_row_id = rows.finance_row_id
          and (groups.reconciliation_state <> 'canonical' or groups.canonical_finance_row_id <> rows.finance_row_id)
      )
    for update of locked_rows
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
      encode(digest(rows.finance_row_id::text, 'sha256'), 'hex'),
      'payment_tracker',
      jsonb_build_object(
        'finance_row_id', rows.finance_row_id,
        'finance_import_id', rows.import_id,
        'source_tab', rows.source_tab,
        'source_row_number', rows.source_row_number,
        'finance_payment_method', rows.finance_payment_method,
        'raw_category', rows.source_category_raw,
        'membership_type', rows.membership_tier,
        'source_occurred_on', rows.source_occurred_on,
        'source_amount_usd', rows.source_amount_usd,
        'effective_occurred_on', rows.occurred_on,
        'effective_amount_usd', rows.amount_usd,
        'effective_category', rows.category_raw,
        'source_amount_basis', 'gross_excluding_vat',
        'lineage_id', rows.lineage_id
      )
    from postable_rows rows
    returning id, source_metadata
  ),
  inserted_posts as (
    insert into public.b2c_finance_ledger_posts (
      finance_row_id, payment_id, finance_payment_method,
      source_amount_basis, posted_by, lineage_id
    )
    select
      (payments.source_metadata ->> 'finance_row_id')::uuid,
      payments.id,
      payments.source_metadata ->> 'finance_payment_method',
      'gross_excluding_vat',
      auth.uid(),
      (payments.source_metadata ->> 'lineage_id')::uuid
    from inserted_payments payments
    returning lineage_id
  )
  select count(*) into posted from inserted_posts;

  return query select posted, already_posted, greatest(supported_rows - posted - already_posted, 0);
end;
$$;

revoke all on function public.post_approved_b2c_finance_payments() from public;
grant execute on function public.post_approved_b2c_finance_payments() to authenticated;

-- Read-only posting-readiness feed for the single Ready-to-post panel. Built
-- from the same current-linked-row-per-lineage shape as the posting function
-- above, classifying every confirmed lineage and surfacing every
-- import-version candidate still awaiting an Admin decision. 'removed'
-- candidates (a prior row absent from a replacement workbook) are a coverage
-- concern, not a posting concern, and have no decision path, so they are
-- excluded here.
create or replace function public.get_b2c_finance_posting_readiness()
returns table (
  row_kind text,
  status text,
  candidate_kind text,
  finance_payment_method text,
  finance_row_count integer
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can view B2C Finance posting readiness';
  end if;

  return query
  with current_linked_rows as (
    select distinct on (links.lineage_id)
      links.lineage_id,
      links.finance_row_id,
      lineages.represented_payment_id,
      effective.occurred_on,
      effective.amount_usd,
      case trim(regexp_replace(lower(coalesce(effective.payment_method_raw, '')), '[^a-z0-9]+', ' ', 'g'))
        when 'bank transfer' then 'bank_transfer'
        when 'ios' then 'ios'
      end as finance_payment_method,
      regexp_replace(
        regexp_replace(lower(trim(coalesce(effective.category_raw, ''))), '[^a-z0-9]+', '-', 'g'),
        '(^-+|-+$)', '', 'g'
      ) as category_code,
      effective.effective_quality
    from public.b2c_finance_row_lineage_links links
    join public.b2c_finance_record_lineages lineages on lineages.id = links.lineage_id
    join public.b2c_finance_effective_rows effective on effective.id = links.finance_row_id
    join public.b2c_finance_staging_rows source_rows on source_rows.id = links.finance_row_id
    join public.b2c_finance_imports imports on imports.id = source_rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
    order by links.lineage_id, links.created_at desc
  )
  select
    'lineage'::text as row_kind,
    case
      when clr.represented_payment_id is not null then 'represented'
      when exists (
        select 1 from public.b2c_finance_ledger_posts posts where posts.lineage_id = clr.lineage_id
      ) then 'already_posted'
      when clr.effective_quality = 'valid'
        and clr.amount_usd > 0
        and clr.occurred_on is not null
        and clr.finance_payment_method is not null
        and clr.category_code <> ''
        and not exists (
          select 1
          from public.b2c_reconciliation_finance_rows group_rows
          join public.b2c_reconciliation_groups groups on groups.id = group_rows.reconciliation_group_id
          where group_rows.finance_row_id = clr.finance_row_id
            and (groups.reconciliation_state <> 'canonical' or groups.canonical_finance_row_id <> clr.finance_row_id)
        )
        then 'ready'
      else 'blocked'
    end as status,
    null::text as candidate_kind,
    clr.finance_payment_method,
    1 as finance_row_count
  from current_linked_rows clr
  union all
  select
    'pending_candidate'::text as row_kind,
    null::text as status,
    candidates.candidate_kind,
    null::text as finance_payment_method,
    cardinality(candidates.finance_row_ids) as finance_row_count
  from public.b2c_finance_import_version_candidates candidates
  where candidates.candidate_kind <> 'removed'
    and not exists (
      select 1 from public.b2c_finance_import_version_decisions decisions
      where decisions.candidate_id = candidates.id
    );
end;
$$;

revoke all on function public.get_b2c_finance_posting_readiness() from public;
grant execute on function public.get_b2c_finance_posting_readiness() to authenticated;
