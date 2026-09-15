-- ---------------------------------------------------------------------------
-- Remove the B2C "Category" concept entirely.
--
-- b2c_payments.category_code was a manually-classified PLAYBOOK-internal
-- reporting label, separate from the Description field (which carries the real
-- Stripe/Tap product name and is untouched here). It required a per-payment
-- Admin action that was never performed: every payment row ever imported
-- carries category_code = 'unmapped'. The bulk/product-level auto-mapping path
-- that would have populated it was already retired (see the product_mappings
-- RETIRED-OPTIONAL note in 20270101000200_b2c_foundation.sql); this migration
-- removes the concept itself, including the now-unreachable mapping table and
-- its two dead RPCs.
--
-- DUPLICATE FINGERPRINT CHANGE. category_code was one input to the B2C
-- duplicate-detection fingerprint (email + amount + category + business date).
-- Because every row has always held the identical value 'unmapped', that
-- segment has never discriminated between any two rows: removing it is a
-- provable no-op against all data that has ever existed in this system, not a
-- behavior change. The fingerprint becomes email + USD amount + business date.
-- The TypeScript half lives in src/lib/b2c/duplicate-fingerprint.ts and
-- src/server/services/record-manual-bank-transfer.ts and is changed in
-- lockstep; tests/b2c-hash-parity.test.ts asserts the two agree.
--
-- membership_tier is a SEPARATE, INDEPENDENT concept and is deliberately
-- preserved everywhere below: it keeps its column on b2c_payments and on
-- b2c_payment_local_overrides, keeps its own check constraint, and keeps its
-- parameter in both surviving RPCs. It was never part of the fingerprint.
--
-- Existing fingerprints are NOT recomputed. Stored values stay on the old
-- algorithm until each row is next written; grouping compares fingerprints
-- computed by get_effective_b2c_duplicate_facts at read time, which is
-- recreated below, so duplicate detection is internally consistent
-- immediately. See the note on b2c_payments.duplicate_fingerprint below.
-- ---------------------------------------------------------------------------

-- 1. Triggers first: their watched-column lists name category_code, so they
--    must be dropped before the column can go. Recreated at the end.
drop trigger if exists open_b2c_payment_duplicate_group_after_payment_write on public.b2c_payments;
drop trigger if exists open_b2c_payment_duplicate_group_after_override_write on public.b2c_payment_local_overrides;

-- 2. Functions whose SIGNATURE or RETURN TYPE changes cannot be handled by
--    CREATE OR REPLACE (that would leave a second overload behind), so drop
--    them explicitly. The two product-mapping functions are dropped for good.
drop function if exists public.apply_stripe_product_mapping(text, text, text, text, text, text);
drop function if exists public.apply_b2c_product_mapping(text, text, text, text, text, text, text);
drop function if exists public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text);
drop function if exists public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text);
drop function if exists public.get_effective_b2c_duplicate_facts(uuid);

-- 3. Columns. b2c_payments.product_mapping_id is the FK into the mapping table
--    being dropped; category_code carries an inline (unnamed) check constraint
--    that Postgres drops along with the column.
alter table public.b2c_payments drop column product_mapping_id;
alter table public.b2c_payments drop column category_code;

-- The local-overlay "at least one correction present" constraint names
-- category_code. Postgres would silently drop that whole multi-column check
-- along with the column, so drop and re-add it deliberately, minus category.
-- membership_tier and its own length check are untouched.
alter table public.b2c_payment_local_overrides
  drop constraint b2c_payment_local_overrides_has_correction_check;
alter table public.b2c_payment_local_overrides drop column category_code;
alter table public.b2c_payment_local_overrides
  add constraint b2c_payment_local_overrides_has_correction_check check (
    customer_name is not null
    or customer_email is not null
    or customer_phone is not null
    or membership_tier is not null
    or local_amount_usd is not null
    or local_occurred_on is not null
  );

-- 4. The mapping table itself. Dropping it also drops its updated_at trigger,
--    its RLS policy, and the audit_product_mappings trigger that
--    20270101000400_cross_domain_sweep.sql attaches to it.
drop table public.product_mappings;

-- ---------------------------------------------------------------------------
-- 5. Recreate the surviving RPCs without category_code.
-- ---------------------------------------------------------------------------

-- Manual bank transfer. The required facts are now bank reference, customer
-- name, verified customer email, USD amount, transfer date/time with an
-- explicit offset, and an audit reason. Category was the only required field
-- removed; nothing replaces it, because there is no longer a classification to
-- require. membership_tier remains optional, exactly as before.
create or replace function public.record_b2c_manual_bank_transfer(
  p_bank_reference text, p_customer_email text, p_customer_name text,
  p_membership_tier text, p_amount_usd_text text,
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
  if p_membership_tier is not null and char_length(trim(p_membership_tier)) not between 1 and 100 then
    raise exception 'Plan or tier must be between 1 and 100 characters';
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
    coalesce(trim(p_membership_tier), '') || '|' ||
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
      membership_tier, payment_status,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on,
      duplicate_fingerprint, manual_entry_reason, entered_by
    ) values (
      'manual_bank_transfer', trim(p_bank_reference), trim(p_customer_name), lower(trim(p_customer_email)),
      nullif(trim(p_membership_tier), ''), 'succeeded',
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

-- Local correction workflow, minus the category overlay. membership_tier keeps
-- its parameter, its validation, its overlay precedence, and its place in the
-- append-only financial_corrections audit payload.
create or replace function public.apply_b2c_payment_local_correction(
  p_payment_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_membership_tier text,
  p_local_amount_usd numeric(20, 6),
  p_local_occurred_on date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  prior_override public.b2c_payment_local_overrides%rowtype;
  effective_customer_name text;
  effective_customer_email citext;
  effective_customer_phone text;
  effective_membership_tier text;
  effective_amount_usd numeric(20, 6);
  effective_occurred_on date;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a local B2C correction';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A correction reason must be between 3 and 1000 characters';
  end if;
  if p_customer_name is null and p_customer_email is null and p_customer_phone is null
    and p_membership_tier is null
    and p_local_amount_usd is null and p_local_occurred_on is null then
    raise exception 'Enter at least one verified local correction';
  end if;
  if p_customer_name is not null and char_length(trim(p_customer_name)) not between 1 and 200 then
    raise exception 'Customer name must be between 1 and 200 characters';
  end if;
  if p_customer_email is not null and trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid customer email';
  end if;
  if p_customer_phone is not null and char_length(trim(p_customer_phone)) not between 5 and 40 then
    raise exception 'Customer mobile must be between 5 and 40 characters';
  end if;
  if p_membership_tier is not null and char_length(trim(p_membership_tier)) not between 1 and 100 then
    raise exception 'Membership tier must be between 1 and 100 characters';
  end if;
  if p_local_amount_usd is not null and p_local_amount_usd <= 0 then
    raise exception 'Local USD amount must be greater than zero';
  end if;

  -- Keep the workflow mutex ahead of the strong payment/override row locks.
  -- The override trigger reacquires it reentrantly in this transaction.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_payment
  from public.b2c_payments
  where id = p_payment_id
  for update;
  if not found then
    raise exception 'The B2C payment is unavailable';
  end if;

  select * into prior_override
  from public.b2c_payment_local_overrides
  where payment_id = p_payment_id
  for update;

  effective_customer_name := coalesce(nullif(trim(p_customer_name), ''), prior_override.customer_name, target_payment.customer_name);
  effective_customer_email := coalesce(nullif(lower(trim(p_customer_email)), ''), prior_override.customer_email, target_payment.customer_email);
  effective_customer_phone := coalesce(nullif(trim(p_customer_phone), ''), prior_override.customer_phone, target_payment.customer_phone);
  effective_membership_tier := coalesce(nullif(trim(p_membership_tier), ''), prior_override.membership_tier, target_payment.membership_tier);
  effective_amount_usd := coalesce(p_local_amount_usd, prior_override.local_amount_usd, target_payment.amount_usd);
  effective_occurred_on := coalesce(p_local_occurred_on, prior_override.local_occurred_on, target_payment.occurred_on);

  if effective_customer_name is not distinct from coalesce(prior_override.customer_name, target_payment.customer_name)
    and effective_customer_email is not distinct from coalesce(prior_override.customer_email, target_payment.customer_email)
    and effective_customer_phone is not distinct from coalesce(prior_override.customer_phone, target_payment.customer_phone)
    and effective_membership_tier is not distinct from coalesce(prior_override.membership_tier, target_payment.membership_tier)
    and effective_amount_usd is not distinct from coalesce(prior_override.local_amount_usd, target_payment.amount_usd)
    and effective_occurred_on is not distinct from coalesce(prior_override.local_occurred_on, target_payment.occurred_on) then
    raise exception 'The submitted values do not change this payment';
  end if;

  insert into public.b2c_payment_local_overrides (
    payment_id, customer_name, customer_email, customer_phone,
    membership_tier, local_amount_usd, local_occurred_on, created_by, updated_by
  ) values (
    p_payment_id,
    case when p_customer_name is null then prior_override.customer_name else effective_customer_name end,
    case when p_customer_email is null then prior_override.customer_email else effective_customer_email end,
    case when p_customer_phone is null then prior_override.customer_phone else effective_customer_phone end,
    case when p_membership_tier is null then prior_override.membership_tier else effective_membership_tier end,
    case when p_local_amount_usd is null then prior_override.local_amount_usd else effective_amount_usd end,
    case when p_local_occurred_on is null then prior_override.local_occurred_on else effective_occurred_on end,
    auth.uid(), auth.uid()
  ) on conflict (payment_id) do update set
    customer_name = excluded.customer_name,
    customer_email = excluded.customer_email,
    customer_phone = excluded.customer_phone,
    membership_tier = excluded.membership_tier,
    local_amount_usd = excluded.local_amount_usd,
    local_occurred_on = excluded.local_occurred_on,
    updated_by = auth.uid();

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    jsonb_build_object(
      'customer_name', coalesce(prior_override.customer_name, target_payment.customer_name),
      'customer_email', coalesce(prior_override.customer_email, target_payment.customer_email),
      'customer_phone', coalesce(prior_override.customer_phone, target_payment.customer_phone),
      'membership_tier', coalesce(prior_override.membership_tier, target_payment.membership_tier),
      'amount_usd', coalesce(prior_override.local_amount_usd, target_payment.amount_usd),
      'occurred_on', coalesce(prior_override.local_occurred_on, target_payment.occurred_on)
    ),
    jsonb_build_object(
      'customer_name', effective_customer_name,
      'customer_email', effective_customer_email,
      'customer_phone', effective_customer_phone,
      'membership_tier', effective_membership_tier,
      'amount_usd', effective_amount_usd,
      'occurred_on', effective_occurred_on
    ),
    trim(p_reason), effective_occurred_on
  );

  if p_customer_email is not null then
    insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
    select id, 'resolved', trim(p_reason)
    from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and flag_type = 'needs_follow_up'
      and status = 'open'
      and reason ~* 'missing a valid customer email'
    on conflict (flag_id) do nothing;
  end if;

end;
$$;

revoke all on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, numeric, date, text) from public;
grant execute on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, numeric, date, text) to authenticated;

-- Finance exception: same signature, same guards. Only the category fact is
-- removed from the append-only audit payload.
create or replace function public.include_b2c_payment_with_finance_exception(
  p_payment_id uuid, p_reason text, p_confirmed_provider_transaction boolean, p_confirmed_no_known_duplicate boolean
)
returns void language plpgsql security definer set search_path = public as $$
declare target_payment public.b2c_payments%rowtype; local_override public.b2c_payment_local_overrides%rowtype; fx_conversion public.b2c_payment_fx_conversions%rowtype; effective_amount_usd numeric(20, 6); effective_occurred_on date; prior_decision text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can include a B2C payment by Finance exception'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'A Finance exception reason must be between 3 and 1000 characters'; end if;
  if p_confirmed_provider_transaction is not true or p_confirmed_no_known_duplicate is not true then raise exception 'Confirm the provider transaction and duplicate review before including this payment'; end if;
  select * into target_payment from public.b2c_payments where id = p_payment_id for update;
  if not found then raise exception 'The B2C payment is unavailable'; end if;
  if target_payment.payment_status <> 'succeeded' then raise exception 'Only a succeeded provider payment can be included by Finance exception'; end if;
  if target_payment.provider_transaction_id is null or (select count(*) from public.b2c_payments where provider_transaction_id = target_payment.provider_transaction_id) <> 1 then raise exception 'A Finance exception requires the exact unique provider transaction ID'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'possible_duplicate') then raise exception 'Resolve the possible duplicate before using a Finance exception'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'needs_follow_up' and reason !~* 'missing a valid customer email') then raise exception 'This payment has another unresolved source issue that cannot be bypassed'; end if;
  select * into local_override from public.b2c_payment_local_overrides where payment_id = p_payment_id;
  select * into fx_conversion from public.b2c_payment_fx_conversions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  -- A foreign source can use only its append-only Finance conversion. This
  -- deliberately ignores any historical generic local USD overlay.
  effective_amount_usd := case
    when target_payment.original_currency <> 'USD' then fx_conversion.amount_usd
    else coalesce(local_override.local_amount_usd, target_payment.amount_usd)
  end;
  effective_occurred_on := coalesce(local_override.local_occurred_on, target_payment.occurred_on);
  if effective_amount_usd is null or effective_amount_usd <= 0 or effective_occurred_on is null then raise exception 'Record a Finance-approved USD conversion and verified business date before using a Finance exception'; end if;
  select decision into prior_decision from public.b2c_payment_finance_exception_decisions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  insert into public.b2c_payment_finance_exception_decisions (payment_id, decision, reason, confirmed_provider_transaction, confirmed_no_known_duplicate, created_by) values (p_payment_id, 'include', trim(p_reason), true, true, auth.uid());
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2c_payment', p_payment_id, 'other', jsonb_build_object('finance_exception_decision', coalesce(prior_decision, 'none')), jsonb_build_object('finance_exception_decision', 'include', 'provider_transaction_id', target_payment.provider_transaction_id, 'amount_usd', effective_amount_usd, 'occurred_on', effective_occurred_on, 'missing_source_fields_remain_visible', true), trim(p_reason), effective_occurred_on);
end;
$$;

revoke all on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) from public;
grant execute on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) to authenticated;

-- Effective duplicate facts. The returned fact set and the fingerprint it
-- computes are now email + USD amount + business date. The old
-- `coalesce(o.category_code, p.category_code) is not null` guard is gone with
-- the column: it could never be false, since b2c_payments.category_code was
-- NOT NULL.
create or replace function public.get_effective_b2c_duplicate_facts(p_payment_id uuid)
returns table (
  payment_id uuid,
  customer_email text,
  comparison_amount numeric(20, 6),
  occurred_at timestamptz,
  occurred_on date,
  fingerprint text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id,
    lower(trim(coalesce(o.customer_email, p.customer_email)::text)),
    coalesce(o.local_amount_usd, p.amount_usd),
    p.occurred_at,
    coalesce(o.local_occurred_on, p.occurred_on),
    encode(extensions.digest(
      lower(trim(coalesce(o.customer_email, p.customer_email)::text)) || '|' ||
      'USD|' ||
      coalesce(o.local_amount_usd, p.amount_usd)::numeric(20, 6)::text || '|' ||
      coalesce(o.local_occurred_on, p.occurred_on)::text,
      'sha256'
    ), 'hex')
  from public.b2c_payments p
  left join public.b2c_payment_local_overrides o on o.payment_id = p.id
  where p.id = p_payment_id
    and p.payment_status = 'succeeded'
    and coalesce(o.customer_email, p.customer_email) is not null
    and coalesce(o.local_amount_usd, p.amount_usd) is not null
    and coalesce(o.local_occurred_on, p.occurred_on) is not null;
$$;

revoke all on function public.get_effective_b2c_duplicate_facts(uuid) from public, anon, authenticated;

-- Duplicate-group constructor: the category match condition is removed and the
-- human-readable reason strings no longer mention a category.
create or replace function public.open_b2c_payment_duplicate_group(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  candidate_ids uuid[];
  open_group_id uuid;
  existing_group_id uuid;
  latest_resolved_group_id uuid;
  latest_resolved_member_ids uuid[];
begin
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif auth.uid() is null and auth.role() is null then
    null;
  elsif auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator or trusted database session can create B2C payment duplicate groups';
  end if;

  -- One workflow mutex serializes all group/member/flag decisions. This
  -- constructor never explicitly locks source rows; writers that need a
  -- conflicting source FOR UPDATE take this mutex before that source lock.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  -- Preserve the evidence set captured when this case opened even if a local
  -- correction changes the payment while Finance is reviewing it.
  select duplicate_group.id into existing_group_id
  from public.b2c_payment_duplicate_group_members member
  join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
  where member.payment_id = p_payment_id
    and duplicate_group.status = 'open'
  order by duplicate_group.created_at, duplicate_group.id
  limit 1;
  if found then
    return existing_group_id;
  end if;

  select * into target
  from public.get_effective_b2c_duplicate_facts(p_payment_id);
  if not found then
    return null;
  end if;

  with candidate_facts as (
    select facts.*
    from public.b2c_payments payment
    cross join lateral public.get_effective_b2c_duplicate_facts(payment.id) facts
  ), eligible_candidates as (
    select candidate.payment_id
    from candidate_facts candidate
    where candidate.customer_email = target.customer_email
      and candidate.comparison_amount = target.comparison_amount
      and candidate.occurred_on = target.occurred_on
      and candidate.occurred_at between target.occurred_at - interval '48 hours' and target.occurred_at + interval '48 hours'
      and not exists (
        select 1
        from public.b2c_payment_duplicate_group_members prior_member
        join public.b2c_payment_duplicate_groups prior_group on prior_group.id = prior_member.group_id
        where prior_member.payment_id = candidate.payment_id
          and prior_group.status = 'resolved'
          and prior_member.decision = 'exclude'
      )
  )
  select array_agg(payment_id order by payment_id) into candidate_ids
  from (select distinct payment_id from eligible_candidates) distinct_candidates;

  if coalesce(cardinality(candidate_ids), 0) < 2 then
    return null;
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = any(candidate_ids)
      and duplicate_group.status = 'open'
      and duplicate_group.fingerprint <> target.fingerprint
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;

  select duplicate_group.id into open_group_id
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = target.fingerprint
    and duplicate_group.status = 'open'
  for update;

  if found then
    if exists (
      select 1
      from public.b2c_payment_duplicate_group_members member
      join public.b2c_payment_duplicate_groups other_group on other_group.id = member.group_id
      where member.payment_id = any(candidate_ids)
        and other_group.status = 'open'
        and other_group.id <> open_group_id
    ) then
      raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
    end if;

    insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
    select open_group_id, candidate_id
    from unnest(candidate_ids) candidate_id
    on conflict (group_id, payment_id) do nothing;

    insert into public.review_flags (
      source_area, source_record_id, flag_type, status, priority, reason, created_by
    )
    select
      'b2c_payment', candidate_id, 'possible_duplicate', 'open', 2,
      'Another succeeded B2C payment has the same effective customer email, USD amount, and business date within 48 hours. It is excluded from financial totals pending Admin review.',
      auth.uid()
    from unnest(candidate_ids) candidate_id
    on conflict (source_area, source_record_id, flag_type, status) do update set
      priority = excluded.priority,
      reason = excluded.reason,
      updated_at = timezone('utc', now());

    return open_group_id;
  end if;

  select duplicate_group.id,
    array(
      select member.payment_id
      from public.b2c_payment_duplicate_group_members member
      where member.group_id = duplicate_group.id
      order by member.payment_id
    )
  into latest_resolved_group_id, latest_resolved_member_ids
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = target.fingerprint
    and duplicate_group.status = 'resolved'
  order by duplicate_group.resolved_at desc, duplicate_group.id desc
  limit 1;

  if found and latest_resolved_member_ids = candidate_ids then
    return null;
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = any(candidate_ids)
      and duplicate_group.status = 'open'
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;

  insert into public.b2c_payment_duplicate_groups (fingerprint, detection_reason)
  values (
    target.fingerprint,
    'Succeeded B2C payments share the same effective customer email, USD amount, and business date within 48 hours.'
  )
  returning id into open_group_id;

  insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
  select open_group_id, candidate_id
  from unnest(candidate_ids) candidate_id;

  insert into public.review_flags (
    source_area, source_record_id, flag_type, status, priority, reason, created_by
  )
  select
    'b2c_payment', candidate_id, 'possible_duplicate', 'open', 2,
    'Another succeeded B2C payment has the same effective customer email, USD amount, and business date within 48 hours. It is excluded from financial totals pending Admin review.',
    auth.uid()
  from unnest(candidate_ids) candidate_id
  on conflict (source_area, source_record_id, flag_type, status) do update set
    priority = excluded.priority,
    reason = excluded.reason,
    updated_at = timezone('utc', now());

  return open_group_id;
end;
$$;

revoke all on function public.open_b2c_payment_duplicate_group(uuid) from public, anon;
grant execute on function public.open_b2c_payment_duplicate_group(uuid) to authenticated, service_role;

-- 6. Recreate the duplicate-detection triggers without category_code in their
--    watched-column lists. Every other watched column is unchanged.
create trigger open_b2c_payment_duplicate_group_after_payment_write
  after insert or update of payment_status, customer_email, amount_usd, occurred_at, occurred_on
  on public.b2c_payments
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_payment_write();

create trigger open_b2c_payment_duplicate_group_after_override_write
  after insert or update of customer_email, local_amount_usd, local_occurred_on
  on public.b2c_payment_local_overrides
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_override_write();
