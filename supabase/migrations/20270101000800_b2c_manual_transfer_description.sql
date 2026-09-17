-- ---------------------------------------------------------------------------
-- Manual bank transfer: replace the "membership tier" field with a free-text
-- description that shows up in the Ledger's Description column exactly like
-- a Stripe/Tap description.
--
-- b2c_payments.membership_tier is untouched and keeps its existing meaning
-- for every other source (Stripe's own plan-name heuristic in
-- stripe-sync-repository.ts, and the review drawer's separate "Plan / tier"
-- local-correction field/override, both unrelated to this form). Manual
-- bank transfers simply stop writing to that column -- there was never a
-- real "plan" for a bank transfer, and an Admin can still set membership_tier
-- afterwards via the drawer's existing correction if they want to.
--
-- The Ledger's Description column already reads
-- coalesce(stripe charge_description, source_metadata->>'description')
-- (20270101000600_b2c_ledger_keyset_reads.sql) -- writing the new
-- description into source_metadata means no ledger-SQL change is needed at
-- all; the existing fallback branch picks it up.
-- ---------------------------------------------------------------------------

-- Same 8 text-parameter shape as the live definition
-- (20270101000500_remove_b2c_category.sql) -- only the 4th parameter's name,
-- validation, and the insert body change. Postgres still requires a drop
-- first: `create or replace function` refuses to rename an input parameter
-- (42P13 "cannot change name of input parameter"), even when every type
-- stays identical.
drop function if exists public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text);

create or replace function public.record_b2c_manual_bank_transfer(
  p_bank_reference text, p_customer_email text, p_customer_name text,
  p_description text, p_amount_usd_text text,
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
  if p_description is not null and char_length(trim(p_description)) not between 1 and 200 then
    raise exception 'Description must be between 1 and 200 characters';
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

  -- Mirrors hashPreparedManualBankTransfer in
  -- src/server/services/record-manual-bank-transfer.ts. Change both together.
  computed_hash := encode(digest(
    trim(p_bank_reference) || '|' || lower(trim(p_customer_email)) || '|' || trim(p_customer_name) || '|' ||
    coalesce(trim(p_description), '') || '|' ||
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

  -- Mirrors createB2cDuplicateFingerprint in
  -- src/lib/b2c/duplicate-fingerprint.ts. Change both together.
  duplicate_fp := encode(digest(
    lower(trim(p_customer_email)) || '|USD|' || p_amount_usd_text || '|' ||
    to_char(transfer_occurred_on, 'YYYY-MM-DD'),
    'sha256'
  ), 'hex');

  begin
    insert into public.b2c_payments (
      source_system, provider_transaction_id, customer_name, customer_email,
      payment_status, source_metadata,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on,
      duplicate_fingerprint, manual_entry_reason, entered_by
    ) values (
      'manual_bank_transfer', trim(p_bank_reference), trim(p_customer_name), lower(trim(p_customer_email)),
      'succeeded',
      case when nullif(trim(p_description), '') is not null
        then jsonb_build_object('description', trim(p_description))
        else '{}'::jsonb
      end,
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

revoke all on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text) from public;
grant execute on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text) to authenticated;
