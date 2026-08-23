-- The one canonicalization rule for B2C Finance identity text. It exists
-- because prior inline SQL used unaccent(), while TypeScript used NFKD plus
-- combining-mark removal. Those rules disagree for real names such as Łukasz.
-- Every new SQL identity writer must call this function rather than inlining a
-- normalization rule.
create or replace function public.b2c_canonical_identity_text(value text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(
    btrim(
      regexp_replace(
        regexp_replace(
          normalize(coalesce(value, ''), NFKD),
          '[̀-ͯ҃-҉֑-ֽً-ٰٟۖ-ۜัิ-ฺ᪰-᫿᷀-᷿⃐-⃰︠-︯]',
          '',
          'g'
        ),
        '\s+',
        ' ',
        'g'
      )
    )
  );
$$;

revoke all on function public.b2c_canonical_identity_text(text) from public;
grant execute on function public.b2c_canonical_identity_text(text) to authenticated;

-- A manually entered transfer reserves the same canonical identity that a
-- later Payment Tracker row will use. This forward replacement preserves the
-- immutable lineage record and changes no previously-applied migration.
create or replace function public.reserve_b2c_finance_manual_bank_transfer_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  canonical_name text;
  identity_text text;
  identity_hash char(64);
begin
  if new.source_system <> 'manual_bank_transfer' then
    return new;
  end if;

  canonical_name := public.b2c_canonical_identity_text(new.customer_name);
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

revoke all on function public.reserve_b2c_finance_manual_bank_transfer_lineage() from public;

-- Keep the protected manual-entry check on the same canonical rule as its
-- AFTER INSERT reservation trigger. The function is repeated here rather than
-- editing the already-applied migration that originally introduced it.
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

  canonical_name := public.b2c_canonical_identity_text(p_customer_name);
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
    ) returning * into new_payment;
  exception when unique_violation then
    raise exception 'A manual bank transfer with this reference already exists';
  end;

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
