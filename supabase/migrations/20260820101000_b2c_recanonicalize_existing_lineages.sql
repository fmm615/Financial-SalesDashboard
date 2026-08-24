-- Recompute historical lineage hashes after introducing the shared NFKD rule.
-- This migration is deliberately fail-closed: source rows and candidates stay
-- immutable, and any identity that would split or collide aborts the whole
-- transaction for explicit Finance review instead of silently merging records.
do $$
begin
  if exists (
    with derived as (
      select links.lineage_id,
        encode(extensions.digest(
          public.b2c_canonical_identity_text(rows.normalized_customer_name) || ' ' ||
          to_char(rows.occurred_on, 'YYYY-MM-DD') || ' ' || rows.amount_usd::text || ' ' ||
          public.b2c_canonical_identity_text(rows.payment_method_raw), 'sha256'
        ), 'hex') as canonical_identity
      from public.b2c_finance_row_lineage_links links
      join public.b2c_finance_staging_rows rows on rows.id = links.finance_row_id
      union all
      select lineages.id,
        encode(extensions.digest(
          public.b2c_canonical_identity_text(payments.customer_name) || ' ' ||
          to_char(payments.occurred_on, 'YYYY-MM-DD') || ' ' || payments.amount_usd::text || ' bank transfer', 'sha256'
        ), 'hex')
      from public.b2c_finance_record_lineages lineages
      join public.b2c_payments payments on payments.id = lineages.represented_payment_id
      where payments.source_system = 'manual_bank_transfer'
    )
    select 1 from derived group by lineage_id having count(distinct canonical_identity) <> 1
  ) then
    raise exception 'B2C Finance canonicalization migration found one lineage with multiple canonical identities; resolve the source records explicitly before retrying';
  end if;

  if exists (
    with derived as (
      select links.lineage_id,
        encode(extensions.digest(
          public.b2c_canonical_identity_text(rows.normalized_customer_name) || ' ' ||
          to_char(rows.occurred_on, 'YYYY-MM-DD') || ' ' || rows.amount_usd::text || ' ' ||
          public.b2c_canonical_identity_text(rows.payment_method_raw), 'sha256'
        ), 'hex') as canonical_identity
      from public.b2c_finance_row_lineage_links links
      join public.b2c_finance_staging_rows rows on rows.id = links.finance_row_id
      union all
      select lineages.id,
        encode(extensions.digest(
          public.b2c_canonical_identity_text(payments.customer_name) || ' ' ||
          to_char(payments.occurred_on, 'YYYY-MM-DD') || ' ' || payments.amount_usd::text || ' bank transfer', 'sha256'
        ), 'hex')
      from public.b2c_finance_record_lineages lineages
      join public.b2c_payments payments on payments.id = lineages.represented_payment_id
      where payments.source_system = 'manual_bank_transfer'
    )
    select 1 from derived group by canonical_identity having count(distinct lineage_id) > 1
  ) then
    raise exception 'B2C Finance canonicalization migration found colliding historical lineages; resolve them explicitly before retrying';
  end if;

  -- Candidates are immutable decision evidence. If a historical candidate
  -- differs under NFKD, stop rather than rewriting what Finance reviewed.
  if exists (
    with derived as (
      select candidates.id,
        encode(extensions.digest(
          public.b2c_canonical_identity_text(rows.normalized_customer_name) || ' ' ||
          to_char(rows.occurred_on, 'YYYY-MM-DD') || ' ' || rows.amount_usd::text || ' ' ||
          public.b2c_canonical_identity_text(rows.payment_method_raw), 'sha256'
        ), 'hex') as canonical_identity
      from public.b2c_finance_import_version_candidates candidates
      join lateral unnest(candidates.finance_row_ids) as row_id on true
      join public.b2c_finance_staging_rows rows on rows.id = row_id
    )
    select 1
    from derived
    join public.b2c_finance_import_version_candidates candidates on candidates.id = derived.id
    group by derived.id, candidates.source_identity
    having count(distinct canonical_identity) <> 1
      or min(canonical_identity) <> candidates.source_identity
  ) then
    raise exception 'B2C Finance canonicalization migration found an immutable import candidate whose canonical identity would change; resolve it explicitly before retrying';
  end if;
end;
$$;

with derived as (
  select links.lineage_id,
    encode(extensions.digest(
      public.b2c_canonical_identity_text(rows.normalized_customer_name) || ' ' ||
      to_char(rows.occurred_on, 'YYYY-MM-DD') || ' ' || rows.amount_usd::text || ' ' ||
      public.b2c_canonical_identity_text(rows.payment_method_raw), 'sha256'
    ), 'hex') as canonical_identity
  from public.b2c_finance_row_lineage_links links
  join public.b2c_finance_staging_rows rows on rows.id = links.finance_row_id
  union all
  select lineages.id,
    encode(extensions.digest(
      public.b2c_canonical_identity_text(payments.customer_name) || ' ' ||
      to_char(payments.occurred_on, 'YYYY-MM-DD') || ' ' || payments.amount_usd::text || ' bank transfer', 'sha256'
    ), 'hex')
  from public.b2c_finance_record_lineages lineages
  join public.b2c_payments payments on payments.id = lineages.represented_payment_id
  where payments.source_system = 'manual_bank_transfer'
), one_identity_per_lineage as (
  select lineage_id, min(canonical_identity) as canonical_identity
  from derived group by lineage_id
)
update public.b2c_finance_record_lineages lineages
set source_identity = derived.canonical_identity
from one_identity_per_lineage derived
where lineages.id = derived.lineage_id
  and lineages.source_identity <> derived.canonical_identity;
