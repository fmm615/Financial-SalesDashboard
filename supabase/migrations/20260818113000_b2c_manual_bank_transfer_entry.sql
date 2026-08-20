-- Live manual bank-transfer entry (see "Three Payment-Entry Paths" in the B2C
-- single-workspace plan). A genuinely new bank transfer not already present
-- in Payment Tracker is the ONLY thing this path may create. Every check the
-- browser's preview already ran (assessManualBankTransferDuplicates, in
-- src/server/repositories/b2c-payments-repository.ts) is re-run here, inside
-- one locked, atomic transaction, because the preview is read-only and
-- advisory -- this function is the sole authority.
--
-- Rejection order matches the plan: exact bank reference, then exact Finance
-- source-identity (Task 1's createFinanceSourceIdentity formula, mirrored in
-- SQL the same way Task 1's reserve_b2c_finance_manual_bank_transfer_lineage
-- trigger already mirrors it), then the standard 48-hour content check
-- (createB2cDuplicateFingerprint's formula, also mirrored). A standard-check
-- match is not rejected -- it atomically retains the payment AND opens a
-- `possible_duplicate` review flag in the same transaction, so it is excluded
-- from totals until an audited decision.
create or replace function public.record_b2c_manual_bank_transfer(
  p_bank_reference text,
  p_customer_email text,
  p_customer_name text,
  p_category_code text,
  p_membership_tier text,
  p_amount_usd_text text,
  p_received_at_raw text,
  p_reason text,
  p_expected_input_sha256 text
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
  canonical_name text;
  finance_identity text;
  duplicate_fp text;
  found_lineage_id uuid;
  found_represented_payment_id uuid;
  possible_match_count integer;
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

  begin
    transfer_occurred_at := p_received_at_raw::timestamptz;
  exception when others then
    raise exception 'A valid bank transfer date/time with an explicit offset is required';
  end;
  transfer_occurred_on := (transfer_occurred_at at time zone 'Asia/Bahrain')::date;

  -- The reviewed-input hash is computed from the exact parameter values this
  -- function receives, so it only ever verifies internal consistency between
  -- what the Admin reviewed at preview time and what is being confirmed now
  -- -- never a cross-language recomputation from raw source text.
  computed_hash := encode(digest(
    trim(p_bank_reference) || '|' || lower(trim(p_customer_email)) || '|' || trim(p_customer_name) || '|' ||
    trim(p_category_code) || '|' || coalesce(trim(p_membership_tier), '') || '|' ||
    p_amount_usd_text || '|' || trim(p_received_at_raw) || '|' || trim(p_reason),
    'sha256'
  ), 'hex');
  if computed_hash <> p_expected_input_sha256 then
    raise exception 'The reviewed bank transfer details changed since preview. Start again.';
  end if;

  -- Serializes concurrent confirmations for the same bank reference so two
  -- cannot both succeed; the unique (source_system, provider_transaction_id)
  -- index is the hard backstop if this lock is ever bypassed.
  perform pg_advisory_xact_lock(hashtext('b2c_manual_bank_transfer:' || lower(trim(p_bank_reference))));

  if exists (
    select 1 from public.b2c_payments
    where source_system = 'manual_bank_transfer' and provider_transaction_id = trim(p_bank_reference)
  ) then
    raise exception 'A manual bank transfer with this reference already exists';
  end if;

  -- Exact Finance source-identity match: Task 1's identity formula, covering
  -- both a posted-or-unposted confirmed lineage (including one already
  -- represented by an earlier manual payment) and an unresolved import-
  -- version candidate still awaiting an Admin decision.
  canonical_name := lower(public.unaccent(trim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g'))));
  finance_identity := encode(digest(
    canonical_name || ' ' || to_char(transfer_occurred_on, 'YYYY-MM-DD') || ' ' || p_amount_usd_text || ' bank transfer',
    'sha256'
  ), 'hex');

  select lineage.id, lineage.represented_payment_id into found_lineage_id, found_represented_payment_id
  from public.b2c_finance_record_lineages lineage
  where lineage.source_identity = finance_identity;

  if found then
    raise exception 'This transfer matches an existing Payment Tracker bank-transfer record. Link the evidence instead of recording it again.';
  end if;

  if exists (
    select 1 from public.b2c_finance_import_version_candidates candidate
    where candidate.source_identity = finance_identity
      and not exists (
        select 1 from public.b2c_finance_import_version_decisions decision
        where decision.candidate_id = candidate.id
      )
  ) then
    raise exception 'This transfer matches an unresolved Payment Tracker row awaiting review. Resolve that import version decision instead.';
  end if;

  -- Standard 48-hour content check (createB2cDuplicateFingerprint's formula):
  -- a match here is retained and flagged, never rejected outright.
  duplicate_fp := encode(digest(
    lower(trim(p_customer_email)) || '|USD|' || p_amount_usd_text || '|' || lower(trim(p_category_code)) || '|' ||
    to_char(transfer_occurred_on, 'YYYY-MM-DD'),
    'sha256'
  ), 'hex');

  select count(*) into possible_match_count
  from public.b2c_payments existing
  where existing.payment_status = 'succeeded'
    and existing.duplicate_fingerprint = duplicate_fp
    and existing.occurred_at between transfer_occurred_at - interval '48 hours' and transfer_occurred_at + interval '48 hours';

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
    )
    returning * into new_payment;
  exception when unique_violation then
    raise exception 'A manual bank transfer with this reference already exists';
  end;

  -- Task 1's reserve_b2c_finance_manual_bank_transfer_lineage AFTER INSERT
  -- trigger fires here automatically and reserves this payment's Finance
  -- source-identity, so a later Payment Tracker version recognizes it and
  -- can only link evidence to it, never repost it.

  if possible_match_count > 0 then
    insert into public.review_flags (source_area, source_record_id, flag_type, status, priority, reason, created_by)
    values (
      'b2c_payment', new_payment.id, 'possible_duplicate', 'open', 2,
      'Another completed B2C payment has the same customer, amount, category, and Bahrain business date within 48 hours. It is excluded from financial totals pending Admin review.',
      actor
    );
  end if;

  return new_payment;
end;
$$;

revoke all on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) to authenticated;
