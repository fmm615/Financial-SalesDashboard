-- Removes the entire Payment Tracker Excel-workbook system: upload/parsing
-- staging, Tap-statement/Stripe-Charges CSV provider-evidence staging (their
-- TypeScript consumers were already removed once the product owner decided
-- Stripe/Tap's own APIs are the sole source of truth), exact cross-tab
-- duplicate grouping between the `B2C`/`B2C Cons` tabs, lineage tracking and
-- canonicalization, Finance staging-row corrections/date-authority actions,
-- and the posting of approved iOS/bank-transfer rows into real B2C payments.
--
-- A brand new iOS/bank-transfer ingestion system will be designed and built
-- separately; there is an intentional functionality gap for that ingestion
-- until it exists.
--
-- This migration is additive-only with respect to history: every earlier
-- migration file that created these objects is left untouched. It does NOT
-- delete any existing `b2c_payments` row (including historical
-- `source_system = 'finance_tracker'` rows, which remain fully reportable
-- ledger history with their provenance preserved in `source_metadata`), and
-- it does not touch `b2c_payment_duplicate_groups`/`b2c_payment_duplicate_group_members`
-- (the unrelated, kept content-fingerprint dedup system) or anything
-- Stripe/Tap-API-specific (`b2c_stripe_payment_details`, sync/backfill,
-- `b2c_stripe_refund_details`, etc).
--
-- Manual Bank Transfer entry (`record_b2c_manual_bank_transfer`) is kept
-- working: its exact bank-reference-match check and its generic 48-hour
-- content-duplicate check (now handled entirely by the kept
-- `b2c_payment_duplicate_groups` trigger) are untouched. Only the third,
-- Payment-Tracker-lineage-specific check -- "an exact match against a posted
-- or unposted Payment Tracker bank_transfer lineage also rejects outright" --
-- is removed here, since the lineage tables it depended on are dropped below.
-- The lineage-reservation trigger this function relied on
-- (`reserve_b2c_finance_manual_bank_transfer_lineage`, fired after every
-- `b2c_payments` insert) is dropped for the same reason.

-- 1. Surgically trim record_b2c_manual_bank_transfer: remove only the
--    Payment-Tracker-lineage exact-match and unresolved-candidate checks.
--    Everything else (bank-reference lock/check, input-hash replay
--    protection, six-decimal amount validation, Bahrain business-date
--    derivation, duplicate fingerprint, and the insert itself) is unchanged
--    from supabase/migrations/20260820113000_b2c_manual_transfer_offset_guard.sql.
create or replace function public.record_b2c_manual_bank_transfer(
  p_bank_reference text, p_customer_email text, p_customer_name text,
  p_category_code text, p_membership_tier text, p_amount_usd_text text,
  p_received_at_raw text, p_reason text, p_expected_input_sha256 text
)
returns public.b2c_payments
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor uuid;
  computed_hash text;
  transfer_occurred_at timestamptz;
  transfer_occurred_on date;
  duplicate_fp text;
  new_payment public.b2c_payments%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a manual bank transfer';
  end if;
  actor := auth.uid();

  if char_length(trim(coalesce(p_bank_reference, ''))) not between 1 and 200 then
    raise exception 'A bank reference between 1 and 200 characters is required';
  end if;
  if char_length(trim(coalesce(p_customer_name, ''))) not between 1 and 200 then
    raise exception 'A customer name is required';
  end if;
  if p_customer_email is null or trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'A verified customer email is required';
  end if;
  if char_length(trim(coalesce(p_category_code, ''))) < 1 then
    raise exception 'A category is required';
  end if;
  if p_amount_usd_text is null or p_amount_usd_text !~ '^[0-9]+\.[0-9]{6}$' or p_amount_usd_text::numeric <= 0 then
    raise exception 'A positive USD amount with six decimal places is required';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A reason is required';
  end if;
  if coalesce(p_expected_input_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the entered details before recording them';
  end if;

  -- Postgres would resolve an offset-less timestamp in the session timezone,
  -- silently recording the wrong instant (and possibly the wrong Bahrain
  -- business date) for an Admin working elsewhere. Require the offset.
  if p_received_at_raw !~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    raise exception 'The bank transfer date/time must include an explicit UTC offset';
  end if;

  begin
    transfer_occurred_at := p_received_at_raw::timestamptz;
  exception when others then
    raise exception 'A valid bank transfer date/time with an explicit offset is required';
  end;
  transfer_occurred_on := (transfer_occurred_at at time zone 'Asia/Bahrain')::date;

  computed_hash := encode(digest(
    trim(p_bank_reference) || '|' || lower(trim(p_customer_email)) || '|' || trim(p_customer_name) || '|' ||
    trim(p_category_code) || '|' || coalesce(trim(p_membership_tier), '') || '|' ||
    p_amount_usd_text || '|' || trim(p_received_at_raw) || '|' || trim(p_reason),
    'sha256'
  ), 'hex');
  if computed_hash <> p_expected_input_sha256 then
    raise exception 'The reviewed bank transfer details changed since preview. Start again.';
  end if;

  perform pg_advisory_xact_lock(hashtext('b2c_manual_bank_transfer:' || lower(trim(p_bank_reference))));
  if exists (
    select 1 from public.b2c_payments
    where source_system = 'manual_bank_transfer' and provider_transaction_id = trim(p_bank_reference)
  ) then
    raise exception 'A manual bank transfer with this reference already exists';
  end if;

  duplicate_fp := encode(digest(
    lower(trim(p_customer_email)) || '|USD|' || p_amount_usd_text || '|' || lower(trim(p_category_code)) || '|' ||
    to_char(transfer_occurred_on, 'YYYY-MM-DD'),
    'sha256'
  ), 'hex');

  begin
    insert into public.b2c_payments (
      source_system, provider_transaction_id, customer_name, customer_email,
      category_code, membership_tier, payment_status,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on,
      duplicate_fingerprint, manual_entry_reason, entered_by
    ) values (
      'manual_bank_transfer', trim(p_bank_reference), trim(p_customer_name), lower(trim(p_customer_email)),
      trim(p_category_code), nullif(trim(p_membership_tier), ''), 'succeeded',
      p_amount_usd_text::numeric(20, 6), 'USD', 1,
      p_amount_usd_text::numeric(20, 6), p_amount_usd_text::numeric(20, 6), transfer_occurred_at, transfer_occurred_on,
      duplicate_fp, trim(p_reason), actor
    ) returning * into new_payment;
  exception when unique_violation then
    raise exception 'A manual bank transfer with this reference already exists';
  end;

  return new_payment;
end;
$$;

revoke all on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) to authenticated;

-- 2. Drop the lineage-reservation trigger on the surviving b2c_payments table.
drop trigger if exists reserve_b2c_finance_manual_bank_transfer_lineage on public.b2c_payments;
drop function if exists public.reserve_b2c_finance_manual_bank_transfer_lineage();

-- 3. Drop the two Payment-Tracker-only views before their underlying tables.
drop view if exists public.b2c_finance_effective_ledger_entries;
drop view if exists public.b2c_finance_effective_rows;

-- 4. Drop tables, children before parents.
drop table if exists public.b2c_finance_import_version_decisions;
drop table if exists public.b2c_provider_evidence_payment_links;
drop table if exists public.b2c_finance_ledger_adjustments;
drop table if exists public.b2c_finance_row_overrides;
drop table if exists public.b2c_reconciliation_decisions;
drop table if exists public.b2c_reconciliation_finance_rows;
drop table if exists public.b2c_reconciliation_provider_evidence;
drop table if exists public.b2c_finance_row_lineage_links;
drop table if exists public.b2c_finance_ledger_posts;
drop table if exists public.b2c_finance_import_version_candidates;
drop table if exists public.b2c_finance_record_lineages;
drop table if exists public.b2c_reconciliation_groups;
drop table if exists public.b2c_finance_staging_rows;
drop table if exists public.b2c_provider_evidence;
drop table if exists public.b2c_finance_imports;

-- 5. Drop every standalone function this system owned. `DROP TABLE` above
--    already removed each table's triggers, but not the trigger/RPC function
--    objects themselves.
drop function if exists public.assign_b2c_reconciliation_actor();
drop function if exists public.set_b2c_finance_import_updated_at();
drop function if exists public.require_b2c_reconciliation_import_source();
drop function if exists public.apply_b2c_reconciliation_decision();
drop function if exists public.finalize_b2c_finance_import(text, text, text, text, jsonb);
drop function if exists public.get_b2c_reconciliation_safe_summary();
drop function if exists public.finalize_tap_statement_import(text, text, text, text, jsonb);
drop function if exists public.finalize_stripe_charges_import(text, text, text, text, jsonb);
drop function if exists public.create_b2c_exact_duplicate_groups();
drop function if exists public.assign_b2c_finance_row_override_actor();
drop function if exists public.apply_b2c_finance_row_correction(uuid, date, numeric, text, text, text);
drop function if exists public.apply_b2c_finance_date_authority(uuid[], text);
drop function if exists public.apply_b2c_finance_bulk_canonical_decision(uuid[], text, text);
drop function if exists public.apply_b2c_finance_selected_duplicate_decisions(jsonb, text);
drop function if exists public.post_approved_b2c_finance_payments();
drop function if exists public.prevent_b2c_finance_ledger_adjustment_mutation();
drop function if exists public.apply_b2c_finance_posted_adjustment(uuid, date, numeric, text, text, uuid, text);
drop function if exists public.apply_b2c_finance_posted_adjustment_with_expected_state(uuid, date, numeric, text, text, uuid, text, numeric, date);
drop function if exists public.get_b2c_finance_posted_adjustments();
drop function if exists public.get_b2c_finance_posted_adjustments_page(integer, integer);
drop function if exists public.b2c_finance_unresolved_quality_issues(jsonb, date, numeric, text, text, timestamptz);
drop function if exists public.apply_b2c_finance_row_resolution(uuid, date, numeric, text, text, text, text);
drop function if exists public.assign_b2c_finance_lineage_actor();
drop function if exists public.prevent_b2c_finance_lineage_mutation();
drop function if exists public.finalize_b2c_finance_import_version(text, text, text, text, uuid, jsonb, jsonb, jsonb);
drop function if exists public.apply_b2c_finance_import_version_decision();
drop function if exists public.get_b2c_finance_posting_readiness();
drop function if exists public.assign_b2c_provider_evidence_link_actor();
drop function if exists public.require_b2c_provider_evidence_payment_provider_match();
drop function if exists public.get_b2c_tap_statement_unmatched_ledger_rows();
-- b2c_canonical_identity_text() is now unused: its only callers were the
-- dropped lineage-reservation trigger, the dropped candidate-recanonicalize
-- migration (one-time, already executed), and the lineage check just
-- stripped from record_b2c_manual_bank_transfer above.
drop function if exists public.b2c_canonical_identity_text(text);

-- 6. Drop the now-orphaned enum types (must come after every table/view
--    column that used them is gone).
drop type if exists public.b2c_finance_import_source_kind;
drop type if exists public.b2c_finance_import_status;
drop type if exists public.b2c_finance_row_quality;
drop type if exists public.b2c_reconciliation_state;
drop type if exists public.b2c_provider_evidence_kind;

-- 7. Retire the private Payment Tracker workbook storage bucket. Only the
--    Payment Tracker upload/finalize services (already removed) ever wrote
--    to or read from it. storage.objects/storage.buckets block direct
--    deletes by default (`storage.protect_delete()`); this is the documented
--    escape hatch for an administrative migration, scoped to this
--    transaction only via `set local`.
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'b2c-finance-imports';
drop policy if exists "admins can read B2C Finance import sources" on storage.objects;
drop policy if exists "admins can store B2C Finance import sources" on storage.objects;
drop policy if exists "admins can remove failed B2C Finance import sources" on storage.objects;
delete from storage.buckets where id = 'b2c-finance-imports';
