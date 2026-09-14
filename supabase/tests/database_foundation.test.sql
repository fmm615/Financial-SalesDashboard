begin;

select plan(74);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select has_table('public', 'b2c_payments', 'B2C payments table exists');
select has_table('public', 'b2b_recognised_sales', 'recognised sales table exists separately');
select has_table('public', 'data_coverage', 'coverage table exists for non-zero missing-data states');
select has_table('public', 'operational_targets', 'custom operational targets have a separate table');
select has_table('public', 'operational_target_progress_updates', 'operational progress is append-only');

select has_table(
  'public',
  'b2c_stripe_payment_details',
  'Stripe API enrichment has a separate typed details table'
);

select has_column(
  'public',
  'b2c_stripe_payment_details',
  'checkout_customer_email',
  'Stripe Checkout contact evidence is retained explicitly'
);

select has_column(
  'public',
  'b2c_stripe_payment_details',
  'settlement_fee_amount',
  'Stripe settlement fees remain separate evidence'
);

select has_function(
  'public',
  'get_b2c_stripe_payment_contact_fallbacks',
  array[]::text[],
  'Approved users receive only a protected contact-fallback projection'
);

select ok(
  (select relrowsecurity
    from pg_class
    where oid = 'public.b2c_stripe_payment_details'::regclass),
  'RLS protects Stripe payment enrichment details'
);

-- Assertion was wrong: throws_ok() requires an exact message match (verified
-- empirically -- '%...%' is not treated as a LIKE pattern), and pgTAP has no
-- overload that checks both an errcode and a LIKE-pattern message, so the
-- fix is the exact literal text raised by
-- enforce_b2c_stripe_payment_details_source() in
-- 20260812105000_stripe_read_only_payment_enrichment.sql.
select throws_ok(
  $$
    insert into public.b2c_stripe_payment_details (payment_id, enrichment_status)
    values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'complete')
  $$,
  '23514',
  'Stripe payment details linked payment is not a Stripe payment',
  'Tap payments cannot receive Stripe enrichment details'
);

-- Assertion was wrong: throws_ok() requires an exact message match, and
-- pgTAP has no overload that checks both an errcode and a LIKE-pattern
-- message, so the fix is Postgres's exact auto-generated check-violation
-- text (confirmed against the actual first-run failure output).
select throws_ok(
  $$
    insert into public.operational_targets (
      display_name, value_kind, target_value, unit_label, period_start, period_end,
      finance_reference, revision_reason
    ) values (
      'Tickets', 'quantity', 100.000000, null, '2026-01-01', '2026-12-31',
      'Summit plan', 'Approved operational target'
    )
  $$,
  '23514',
  'new row for relation "operational_targets" violates check constraint "operational_target_quantity_unit_check"',
  'quantity targets require a unit label'
);

insert into public.operational_targets (
  id, display_name, value_kind, target_value, unit_label, period_start, period_end,
  status, finance_reference, revision_reason
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Tickets', 'quantity', 100.000000, 'tickets',
  '2026-01-01', '2026-12-31', 'active', 'Summit plan', 'Approved operational target'
);

select is(
  public.revise_operational_target(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Revised ticket target',
    'quantity',
    125.000000,
    'tickets',
    '2026-01-01',
    '2026-12-31',
    'Updated Summit plan',
    'Finance approved revised target'
  ) is not null,
  true,
  'operational target revision creates a successor'
);

select ok(
  (select status = 'archived' and archived_at is not null
    from public.operational_targets
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  and
  (select revision_number = 2 and status = 'active' and target_value = 125.000000::numeric
    from public.operational_targets
    where display_name = 'Revised ticket target'),
  'operational revision archives the prior target and retains an active successor'
);

-- Assertion was wrong on two counts: (1) 'aaaaaaaa-...' was archived by the
-- revision above, so the require_active_operational_target BEFORE INSERT
-- trigger raises its own P0001 before the evidence_note CHECK is ever
-- reached -- the fixture must target the still-active successor row instead;
-- (2) throws_ok() requires an exact message match (no combined errcode +
-- LIKE-pattern overload exists), so this uses Postgres's exact
-- auto-generated check-violation text.
select throws_ok(
  $$
    insert into public.operational_target_progress_updates (
      target_id, actual_value, effective_on, evidence_note
    ) values (
      (select id from public.operational_targets where display_name = 'Revised ticket target'),
      1.000000, '2026-08-11', ' '
    )
  $$,
  '23514',
  'new row for relation "operational_target_progress_updates" violates check constraint "operational_target_progress_updates_evidence_note_check"',
  'operational progress requires an evidence note'
);

-- Assertion was wrong: with a 3rd string argument, throws_ok(sql, errcode, X)
-- treats X as the expected exact error message (verified empirically), not a
-- free-form description. The real message is Postgres's generic unique-
-- violation text, not this friendly sentence. Passing NULL for the message
-- (4-arg form) checks only the SQLSTATE and uses the last argument as the
-- test description, which was this assertion's real intent.
select throws_ok(
  $$
    insert into public.b2c_payments (
      source_system, provider_transaction_id, customer_email, category_code, payment_status,
      original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
      occurred_at, occurred_on, duplicate_fingerprint
    ) values (
      'stripe', 'pi_test_001', 'duplicate@playbook.test', 'membership', 'succeeded',
      100.000000, 'USD', 1.0000000000, 100.000000, 100.000000,
      '2026-08-01 10:00:00+00', '2026-08-01', repeat('c', 64)
    )
  $$,
  '23505',
  null,
  'duplicate Stripe provider ID is rejected'
);

-- Assertion was wrong: same throws_ok 3-arg exact-message issue as above --
-- 'stripe' fails a plain CHECK constraint with Postgres's generic
-- constraint-violation text, not this friendly sentence.
select throws_ok(
  $$
    insert into public.b2b_companies (source_system, legal_name)
    values ('stripe', 'Stripe must never be B2B')
  $$,
  '23514',
  null,
  'Stripe cannot be classified as a B2B source'
);

select is(
  (select amount_usd from public.b2c_payments where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'),
  100.000000::numeric,
  'original payment remains unchanged after partial refund'
);

select is(
  (select sum(amount_usd) from public.b2c_refunds where payment_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'),
  25.000000::numeric,
  'partial refunds are separate linked rows'
);

select ok(
  (select status = 'resolved' and resolved_at is not null
    from public.review_flags where id = '17171717-1717-4717-8717-171717171717'),
  'resolved review flag remains stored in history'
);

select ok(
  (select coverage_status = 'unavailable' and source_record_count is null
    from public.data_coverage
    where domain_area = 'b2c' and period_start = '2024-01-01'),
  'unavailable backfill is distinguishable from a known zero'
);

select ok(
  (select relrowsecurity
    from pg_class
    where oid = 'public.b2c_payments'::regclass),
  'RLS is enabled on protected B2C data'
);

-- Live manual bank-transfer entry (Task 6): one locked, re-validating RPC.
-- Every check the JS preview already ran is rerun here, inside one atomic
-- transaction, because the preview is read-only and advisory only.
select has_function(
  'public',
  'record_b2c_manual_bank_transfer',
  array['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
  'Manual bank transfer entry has one protected atomic constructor'
);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);

-- Assertion was wrong: throws_ok() requires an exact message match, so this
-- uses the exact literal text raised by record_b2c_manual_bank_transfer().
select throws_ok(
  $$
    select public.record_b2c_manual_bank_transfer(
      'MANUAL-TEST-REF-1', 'newmember@playbook.test', 'New Bank Member', 'membership', null, '150.000000',
      '2026-08-15T08:00:00+03:00', 'Genuinely new bank transfer.', repeat('0', 64)
    )
  $$,
  'P0001',
  'Only an authenticated administrator can record a manual bank transfer',
  'a Viewer cannot record a manual bank transfer'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select throws_ok(
  $$
    select public.record_b2c_manual_bank_transfer(
      'MANUAL-OFFSET-LESS-REF', 'offsetless@playbook.test', 'Offsetless Transfer', 'membership', null, '125.000000',
      '2026-08-15T08:00:00', 'This date/time intentionally has no offset.',
      encode(extensions.digest(
        'MANUAL-OFFSET-LESS-REF|offsetless@playbook.test|Offsetless Transfer|membership||125.000000|2026-08-15T08:00:00|This date/time intentionally has no offset.',
        'sha256'
      ), 'hex')
    )
  $$,
  'P0001',
  'The bank transfer date/time must include an explicit UTC offset',
  'a manual bank transfer timestamp without an explicit UTC offset is rejected'
);

-- A clean, genuinely new transfer creates exactly one retained payment.
select public.record_b2c_manual_bank_transfer(
  'MANUAL-TEST-REF-1', 'newmember@playbook.test', 'New Bank Member', 'membership', null, '150.000000',
  '2026-08-15T08:00:00+03:00', 'Genuinely new bank transfer.',
  encode(extensions.digest(
    'MANUAL-TEST-REF-1|newmember@playbook.test|New Bank Member|membership||150.000000|2026-08-15T08:00:00+03:00|Genuinely new bank transfer.',
    'sha256'
  ), 'hex')
);

select is(
  (select count(*)::int from public.b2c_payments where source_system = 'manual_bank_transfer' and provider_transaction_id = 'MANUAL-TEST-REF-1'),
  1,
  'a clean manual bank transfer creates exactly one retained payment'
);

select is(
  (select entered_by::text from public.b2c_payments where provider_transaction_id = 'MANUAL-TEST-REF-1'),
  '11111111-1111-4111-8111-111111111111',
  'the recording administrator is recorded as the manual bank transfer actor'
);

select is(
  (select manual_entry_reason from public.b2c_payments where provider_transaction_id = 'MANUAL-TEST-REF-1'),
  'Genuinely new bank transfer.',
  'the audited reason is recorded verbatim'
);

-- Exact bank-reference duplication is rejected outright, and this is the same
-- protection that stops two concurrent confirmations for the same reference
-- from both succeeding: the second call always finds the first one's
-- committed row (or its advisory lock) and is rejected.
-- Assertion was wrong: throws_ok() requires an exact message match, so this
-- uses the exact literal text raised by record_b2c_manual_bank_transfer().
select throws_ok(
  $$
    select public.record_b2c_manual_bank_transfer(
      'MANUAL-TEST-REF-1', 'newmember@playbook.test', 'New Bank Member', 'membership', null, '150.000000',
      '2026-08-15T08:00:00+03:00', 'Duplicate attempt.',
      encode(extensions.digest('MANUAL-TEST-REF-1|newmember@playbook.test|New Bank Member|membership||150.000000|2026-08-15T08:00:00+03:00|Duplicate attempt.', 'sha256'), 'hex')
    )
  $$,
  'P0001',
  'A manual bank transfer with this reference already exists',
  'an exact reused bank reference is rejected outright'
);

-- A stale/mismatched reviewed-input hash is rejected before any write, even
-- though every other field would otherwise be accepted.
-- Assertion was wrong: throws_ok() requires an exact message match, so this
-- uses the exact literal text raised by record_b2c_manual_bank_transfer().
select throws_ok(
  $$
    select public.record_b2c_manual_bank_transfer(
      'MANUAL-TEST-REF-STALE', 'freshmember@playbook.test', 'Fresh Member', 'membership', null, '90.000000',
      '2026-08-19T08:00:00+03:00', 'Reason text.', repeat('f', 64)
    )
  $$,
  'P0001',
  'The reviewed bank transfer details changed since preview. Start again.',
  'a stale or mismatched reviewed-input hash is rejected before any write'
);

select is(
  (select count(*)::int from public.b2c_payments where provider_transaction_id = 'MANUAL-TEST-REF-STALE'),
  0,
  'a rejected stale-hash confirmation writes nothing'
);

-- A possible (non-exact) 48-hour content match is retained, not rejected --
-- it atomically opens a blocking possible_duplicate review flag instead.
insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_name, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values (
  'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', 'stripe', 'ch_manual_possible_dup_seed', 'Existing Stripe Payer', 'possible.dup@playbook.test', 'membership', 'succeeded',
  75.000000, 'USD', 1.0000000000, 75.000000, 75.000000,
  '2026-08-18 10:00:00+00', '2026-08-18',
  encode(extensions.digest('possible.dup@playbook.test|USD|75.000000|membership|2026-08-18', 'sha256'), 'hex')
);

select public.record_b2c_manual_bank_transfer(
  'MANUAL-TEST-REF-3', 'possible.dup@playbook.test', 'Different Name Entirely', 'membership', null, '75.000000',
  '2026-08-18T13:00:00+03:00', 'New transfer that happens to match recent content.',
  encode(extensions.digest('MANUAL-TEST-REF-3|possible.dup@playbook.test|Different Name Entirely|membership||75.000000|2026-08-18T13:00:00+03:00|New transfer that happens to match recent content.', 'sha256'), 'hex')
);

select is(
  (select count(*)::int from public.b2c_payments where source_system = 'manual_bank_transfer' and provider_transaction_id = 'MANUAL-TEST-REF-3'),
  1,
  'a possible (non-exact) 48-hour content match is retained as one payment, not rejected'
);

select is(
  (select count(*)::int
    from public.review_flags
    where source_area = 'b2c_payment' and flag_type = 'possible_duplicate' and status = 'open'
      and source_record_id = (select id from public.b2c_payments where provider_transaction_id = 'MANUAL-TEST-REF-3')),
  1,
  'a possible content-duplicate manual bank transfer opens exactly one blocking review flag atomically'
);

-- Database-owned B2C payment duplicate groups. These fixtures deliberately
-- keep source rows immutable and vary source values independently from local
-- effective values.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a1000000-0000-4000-8000-000000000001', 'stripe', 'ch_duplicate_group_a1', 'group.a@playbook.test', 'membership', 'succeeded', 80, 'USD', 1, 80, 80, '2026-08-20 08:00:00+00', '2026-08-20', repeat('1', 64)),
  ('a1000000-0000-4000-8000-000000000002', 'tap', 'tap_duplicate_group_a2', 'GROUP.A@playbook.test', 'MEMBERSHIP', 'succeeded', 80, 'USD', 1, 80, 80, '2026-08-20 09:00:00+00', '2026-08-20', repeat('2', 64));

select set_config(
  'test.b2c_insert_trigger_group_id',
  coalesce((
    select member.group_id::text
    from public.b2c_payment_duplicate_group_members member
    where member.payment_id = 'a1000000-0000-4000-8000-000000000001'
  ), ''),
  true
);

select set_config(
  'test.b2c_duplicate_group_id',
  public.open_b2c_payment_duplicate_group('a1000000-0000-4000-8000-000000000001')::text,
  true
);

select is(
  public.open_b2c_payment_duplicate_group('a1000000-0000-4000-8000-000000000001')::text,
  public.open_b2c_payment_duplicate_group('a1000000-0000-4000-8000-000000000002')::text,
  'repeated detection returns the same open payment duplicate group'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_one',
    'a1000000-0000-4000-8000-000000000099',
    'Finance selected a payment outside the group.'
  ) $$,
  'P0001',
  'The selected canonical payment must belong to this duplicate group',
  'keep-one rejects a payment outside the group'
);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);

select throws_ok(
  $$ select public.open_b2c_payment_duplicate_group('a1000000-0000-4000-8000-000000000001') $$,
  'P0001',
  'Only an authenticated administrator or trusted database session can create B2C payment duplicate groups',
  'a Viewer cannot construct a B2C payment duplicate group'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_all', null, 'Viewer must not decide a Finance duplicate case.'
  ) $$,
  'P0001',
  'Only an authenticated administrator can resolve B2C payment duplicate groups',
  'a Viewer cannot resolve a B2C payment duplicate group'
);

set local role authenticated;

select ok(
  (select states.has_open_duplicate and not states.has_duplicate_exclusion
   from public.get_b2c_payment_duplicate_reporting_states() states
   where states.payment_id = 'a1000000-0000-4000-8000-000000000001'),
  'an approved Viewer receives safe per-payment duplicate reporting booleans'
);

select ok(
  not exists (select 1 from public.b2c_payment_duplicate_groups)
  and not exists (select 1 from public.b2c_payment_duplicate_group_members)
  and not exists (
    select 1
    from public.get_b2c_payment_duplicate_reporting_states() states,
      lateral jsonb_object_keys(to_jsonb(states)) exposed_key
    where exposed_key in ('group_id', 'member_id', 'fingerprint', 'decision', 'canonical_payment_id')
  ),
  'a Viewer cannot select duplicate group/member rows or receive their identifiers'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select ok(
  (select count(distinct member.payment_id) >= 2
   from public.b2c_payment_duplicate_group_members member
   join public.b2c_payments payment on payment.id = member.payment_id
   where member.group_id = current_setting('test.b2c_duplicate_group_id')::uuid
     and payment.payment_status = 'succeeded'),
  'a duplicate group contains at least two distinct succeeded payments'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values (
  'a1000000-0000-4000-8000-000000000003', 'stripe', 'ch_duplicate_group_a3', 'group.a@playbook.test', 'membership', 'succeeded',
  80, 'USD', 1, 80, 80, '2026-08-20 10:00:00+00', '2026-08-20', repeat('3', 64)
);

select is(
  (select count(*)::int from public.b2c_payment_duplicate_group_members
   where group_id = current_setting('test.b2c_duplicate_group_id')::uuid),
  3,
  'a third proven payment extends the same open duplicate group'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_all', null, 'n/a'
  ) $$,
  'P0001',
  'A meaningful duplicate decision reason between 3 and 1000 characters is required',
  'placeholder-only duplicate resolution reasons are rejected'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_all', 'a1000000-0000-4000-8000-000000000001', 'Finance confirmed all transfers are distinct.'
  ) $$,
  'P0001',
  'A keep-all decision cannot select a canonical payment',
  'keep-all rejects a non-null canonical payment'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_one', null, 'Finance selected one retained transfer.'
  ) $$,
  'P0001',
  'A keep-one decision requires a canonical payment from this duplicate group',
  'keep-one rejects a null canonical payment'
);

select public.resolve_b2c_payment_duplicate_group(
  current_setting('test.b2c_duplicate_group_id')::uuid,
  'keep_all', null, 'Finance verified three separate customer payments.'
);

select is(
  (select count(*)::int from public.b2c_payment_duplicate_group_members
   where group_id = current_setting('test.b2c_duplicate_group_id')::uuid and decision = 'include'),
  3,
  'keep-all marks every duplicate-group member for inclusion'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_all', null, 'Attempted second decision.'
  ) $$,
  'P0001',
  'This duplicate group is unavailable or already resolved',
  'a resolved duplicate group rejects a second decision'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a2000000-0000-4000-8000-000000000001', 'stripe', 'ch_duplicate_group_b1', 'group.b@playbook.test', 'coaching', 'succeeded', 90, 'USD', 1, 90, 90, '2026-08-21 08:00:00+00', '2026-08-21', repeat('4', 64)),
  ('a2000000-0000-4000-8000-000000000002', 'tap', 'tap_duplicate_group_b2', 'group.b@playbook.test', 'coaching', 'succeeded', 90, 'USD', 1, 90, 90, '2026-08-21 09:00:00+00', '2026-08-21', repeat('5', 64));

select set_config(
  'test.b2c_keep_one_group_id',
  (select group_id::text from public.b2c_payment_duplicate_group_members where payment_id = 'a2000000-0000-4000-8000-000000000001'),
  true
);

-- Reproduce a historical overlapping open case that predates the defensive
-- one-open-group trigger. This proves resolution checks current database state
-- instead of assuming newer construction invariants have always held.
insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values (
  'a2000000-0000-4000-8000-000000000003', 'stripe', 'ch_historical_overlap_b3', 'historical.overlap@playbook.test', 'membership', 'succeeded',
  91, 'USD', 1, 91, 91, '2026-08-21 10:00:00+00', '2026-08-21', repeat('6', 64)
);

alter table public.b2c_payment_duplicate_group_members
  disable trigger enforce_one_open_b2c_duplicate_group_per_payment;
insert into public.b2c_payment_duplicate_groups (id, fingerprint, detection_reason)
values (
  'b2000000-0000-4000-8000-000000000001', repeat('6', 64),
  'Historical overlapping open case retained for forward-compatible resolution testing.'
);
insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
values
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003');
alter table public.b2c_payment_duplicate_group_members
  enable trigger enforce_one_open_b2c_duplicate_group_per_payment;

select public.resolve_b2c_payment_duplicate_group(
  current_setting('test.b2c_keep_one_group_id')::uuid,
  'keep_one', 'a2000000-0000-4000-8000-000000000001', 'Finance retained the Stripe payment as canonical.'
);

select ok(
  (select count(*) = 1 from public.b2c_payment_duplicate_group_members
   where group_id = current_setting('test.b2c_keep_one_group_id')::uuid and decision = 'include')
  and
  (select count(*) = 1 from public.b2c_payment_duplicate_group_members
   where group_id = current_setting('test.b2c_keep_one_group_id')::uuid and decision = 'exclude'),
  'keep-one includes exactly one member and excludes every other member'
);

select ok(
  exists (
    select 1 from public.review_flags flag
    where flag.source_area = 'b2c_payment' and flag.flag_type = 'possible_duplicate' and flag.status = 'open'
      and flag.source_record_id = 'a2000000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1 from public.review_flags flag
    where flag.source_area = 'b2c_payment' and flag.flag_type = 'possible_duplicate' and flag.status = 'open'
      and flag.source_record_id = 'a2000000-0000-4000-8000-000000000002'
  )
  and exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where duplicate_group.status = 'open'
      and member.payment_id = 'a2000000-0000-4000-8000-000000000001'
  ),
  'member review flags resolve only after no other open duplicate group remains'
);

select public.resolve_b2c_payment_duplicate_group(
  'b2000000-0000-4000-8000-000000000001',
  'keep_all', null, 'Finance completed the retained historical overlap review.'
);

set local role authenticated;

select throws_ok(
  $$ insert into public.b2c_payment_duplicate_groups (fingerprint, detection_reason) values (repeat('f', 64), 'Direct insert attempt') $$,
  '42501', null,
  'an authenticated Admin cannot directly insert a payment duplicate group'
);

select throws_ok(
  $$ update public.b2c_payment_duplicate_groups set detection_reason = 'Direct update attempt' where id = current_setting('test.b2c_duplicate_group_id')::uuid $$,
  '42501', null,
  'an authenticated Admin cannot directly update a payment duplicate group'
);

select throws_ok(
  $$ delete from public.b2c_payment_duplicate_groups where id = current_setting('test.b2c_duplicate_group_id')::uuid $$,
  '42501', null,
  'an authenticated Admin cannot directly delete a payment duplicate group'
);

select throws_ok(
  $$ insert into public.b2c_payment_duplicate_group_members (group_id, payment_id) values (current_setting('test.b2c_duplicate_group_id')::uuid, 'a2000000-0000-4000-8000-000000000001') $$,
  '42501', null,
  'an authenticated Admin cannot directly insert a payment duplicate-group member'
);

select throws_ok(
  $$ update public.b2c_payment_duplicate_group_members set decision = 'pending' where group_id = current_setting('test.b2c_duplicate_group_id')::uuid $$,
  '42501', null,
  'an authenticated Admin cannot directly update a payment duplicate-group member'
);

select throws_ok(
  $$ delete from public.b2c_payment_duplicate_group_members where group_id = current_setting('test.b2c_duplicate_group_id')::uuid $$,
  '42501', null,
  'an authenticated Admin cannot directly delete a payment duplicate-group member'
);

reset role;

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a3000000-0000-4000-8000-000000000001', 'stripe', 'ch_overlap_group_1', 'overlap.old@playbook.test', 'membership', 'succeeded', 30, 'USD', 1, 30, 30, '2026-08-22 08:00:00+00', '2026-08-22', repeat('6', 64)),
  ('a3000000-0000-4000-8000-000000000002', 'tap', 'tap_overlap_group_2', 'overlap.old@playbook.test', 'membership', 'succeeded', 30, 'USD', 1, 30, 30, '2026-08-22 09:00:00+00', '2026-08-22', repeat('7', 64));

select set_config(
  'test.b2c_overlap_group_id',
  (select group_id::text from public.b2c_payment_duplicate_group_members where payment_id = 'a3000000-0000-4000-8000-000000000001'),
  true
);

select public.apply_b2c_payment_local_correction(
  'a3000000-0000-4000-8000-000000000001', null, 'overlap.new@playbook.test', null,
  null, null, 31, null, 'Verified values changed while the original duplicate case remained open.'
);

select throws_ok(
  $$ insert into public.b2c_payments (
    id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
    original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
    occurred_at, occurred_on, duplicate_fingerprint
  ) values (
    'a3000000-0000-4000-8000-000000000003', 'stripe', 'ch_overlap_group_3', 'overlap.new@playbook.test', 'membership', 'succeeded',
    31, 'USD', 1, 31, 31, '2026-08-22 10:00:00+00', '2026-08-22', repeat('8', 64)
  ) $$,
  'P0001',
  'A payment cannot belong to more than one open B2C payment duplicate group',
  'a payment is rejected from a second simultaneous open duplicate group'
);

select throws_ok(
  $$ select public.dismiss_stale_b2c_possible_duplicate_flag(
    (select id from public.review_flags
     where source_area = 'b2c_payment' and source_record_id = 'a3000000-0000-4000-8000-000000000002'
       and flag_type = 'possible_duplicate' and status = 'open'),
    'Attempted dismissal despite current matching evidence.'
  ) $$,
  'P0001',
  'This possible duplicate still has a current duplicate group',
  'a possible-duplicate flag refuses stale dismissal while a current candidate exists'
);

select public.resolve_b2c_payment_duplicate_group(
  current_setting('test.b2c_overlap_group_id')::uuid,
  'keep_one', 'a3000000-0000-4000-8000-000000000002', 'Finance retained only the unchanged source payment.'
);

insert into public.b2c_payment_duplicate_groups (
  id, fingerprint, status, decision, detection_reason, resolution_reason, resolved_by, resolved_at
) values (
  'b3000000-0000-4000-8000-000000000001', repeat('b', 64), 'resolved', 'keep_all',
  'Historical duplicate evidence imported from an approved prior workflow.',
  'Later review included this source without erasing the prior exclusion.',
  '11111111-1111-4111-8111-111111111111', timezone('utc', now())
);
insert into public.b2c_payment_duplicate_group_members (group_id, payment_id, decision)
values ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'include');

select ok(
  (select states.has_duplicate_exclusion
   from public.get_b2c_payment_duplicate_reporting_states() states
   where states.payment_id = 'a3000000-0000-4000-8000-000000000001'),
  'an excluded member remains excluded when a later resolved group includes it'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a4000000-0000-4000-8000-000000000001', 'stripe', 'ch_stale_flag_1', 'stale.one@playbook.test', 'membership', 'succeeded', 41, 'USD', 1, 41, 41, '2026-08-24 08:00:00+00', '2026-08-24', repeat('9', 64)),
  ('a4000000-0000-4000-8000-000000000002', 'stripe', 'ch_historical_flag_2', 'historical.only@playbook.test', 'membership', 'succeeded', 42, 'USD', 1, 42, 42, '2026-08-24 09:00:00+00', '2026-08-24', repeat('a', 64));

insert into public.review_flags (id, source_area, source_record_id, flag_type, status, priority, reason)
values
  ('b4000000-0000-4000-8000-000000000001', 'b2c_payment', 'a4000000-0000-4000-8000-000000000001', 'possible_duplicate', 'open', 2, 'Legacy flag whose former candidate is no longer provable.'),
  ('b4000000-0000-4000-8000-000000000002', 'b2c_payment', 'a4000000-0000-4000-8000-000000000002', 'possible_duplicate', 'open', 2, 'Historical unprovable duplicate flag retained for review.');

select lives_ok(
  $$ select public.dismiss_stale_b2c_possible_duplicate_flag(
    'b4000000-0000-4000-8000-000000000001',
    'Finance confirmed the former candidate no longer exists.'
  ) $$,
  'an orphan possible-duplicate flag is dismissible when no current candidate exists'
);

select public.open_b2c_payment_duplicate_group('a4000000-0000-4000-8000-000000000002');

select is(
  (select status::text from public.review_flags where id = 'b4000000-0000-4000-8000-000000000002'),
  'open',
  'historical backfill leaves an unprovable possible-duplicate flag open'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a5000000-0000-4000-8000-000000000001', 'finance_tracker', null, 'effective.usd@playbook.test', 'membership', 'succeeded', 188, 'BHD', 2.6595744681, 500, 500, '2026-08-25 08:00:00+00', '2026-08-25', repeat('c', 64)),
  ('a5000000-0000-4000-8000-000000000002', 'stripe', 'ch_effective_usd_2', 'effective.usd@playbook.test', 'membership', 'succeeded', 500, 'USD', 1, 500, 500, '2026-08-25 09:00:00+00', '2026-08-25', repeat('d', 64));

select ok(
  exists (
    select 1
    from public.b2c_payment_duplicate_group_members first_member
    join public.b2c_payment_duplicate_group_members second_member on second_member.group_id = first_member.group_id
    where first_member.payment_id = 'a5000000-0000-4000-8000-000000000001'
      and second_member.payment_id = 'a5000000-0000-4000-8000-000000000002'
  ),
  'equal effective USD amounts group even when source currencies and amounts differ'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values (
  'a6000000-0000-4000-8000-000000000001', 'stripe', 'ch_missing_effective_usd', 'no.usd@playbook.test', 'membership', 'succeeded',
  60, 'BHD', null, null, null, '2026-08-26 08:00:00+00', '2026-08-26', repeat('e', 64)
);

select ok(
  not exists (select 1 from public.b2c_payment_duplicate_group_members where payment_id = 'a6000000-0000-4000-8000-000000000001'),
  'a payment without an effective USD amount remains ungrouped'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a7000000-0000-4000-8000-000000000001', 'stripe', 'ch_business_date_1', 'business.date@playbook.test', 'membership', 'succeeded', 25, 'USD', 1, 25, 25, '2026-08-27 23:30:00+00', '2026-08-27', repeat('f', 64)),
  ('a7000000-0000-4000-8000-000000000002', 'tap', 'tap_business_date_2', 'before.correction@playbook.test', 'other', 'succeeded', 26, 'USD', 1, 26, 26, '2026-08-28 00:30:00+00', '2026-08-28', repeat('0', 64));

select public.apply_b2c_payment_local_correction(
  'a7000000-0000-4000-8000-000000000002', null, 'business.date@playbook.test', null,
  'membership', null, 25, null, 'Verified correction retains the distinct business date.'
);

select ok(
  not exists (
    select 1 from public.b2c_payment_duplicate_group_members
    where payment_id in ('a7000000-0000-4000-8000-000000000001'::uuid, 'a7000000-0000-4000-8000-000000000002'::uuid)
  )
  and not exists (
    select 1 from public.review_flags
    where source_area = 'b2c_payment' and flag_type = 'possible_duplicate' and status = 'open'
      and source_record_id in ('a7000000-0000-4000-8000-000000000001'::uuid, 'a7000000-0000-4000-8000-000000000002'::uuid)
  ),
  'equal content on a different business date remains ungrouped even inside 48 hours'
);

select ok(
  current_setting('test.b2c_insert_trigger_group_id') <> '',
  'a succeeded payment insert trigger constructs a duplicate group'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('a8000000-0000-4000-8000-000000000001', 'stripe', 'ch_override_group_1', 'override.target@playbook.test', 'membership', 'succeeded', 55, 'USD', 1, 55, 55, '2026-08-29 08:00:00+00', '2026-08-29', repeat('1', 64)),
  ('a8000000-0000-4000-8000-000000000002', 'tap', 'tap_override_group_2', 'override.before@playbook.test', 'other', 'succeeded', 56, 'USD', 1, 56, 56, '2026-08-29 09:00:00+00', '2026-08-29', repeat('2', 64));

select public.apply_b2c_payment_local_correction(
  'a8000000-0000-4000-8000-000000000002', null, 'override.target@playbook.test', null,
  'membership', null, 55, null, 'Verified effective values match another succeeded payment.'
);

select ok(
  exists (
    select 1
    from public.b2c_payment_duplicate_group_members first_member
    join public.b2c_payment_duplicate_group_members second_member on second_member.group_id = first_member.group_id
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = first_member.group_id
    where first_member.payment_id = 'a8000000-0000-4000-8000-000000000001'
      and second_member.payment_id = 'a8000000-0000-4000-8000-000000000002'
      and duplicate_group.status = 'open'
  ),
  'a verified local override write constructs a group from effective values'
);

select set_config(
  'test.b2c_override_group_id',
  (select group_id::text from public.b2c_payment_duplicate_group_members where payment_id = 'a8000000-0000-4000-8000-000000000001'),
  true
);

select public.resolve_b2c_payment_duplicate_group(
  current_setting('test.b2c_override_group_id')::uuid,
  'keep_all', null, 'Finance verified both corrected payments are distinct.'
);

select ok(
  public.open_b2c_payment_duplicate_group('a8000000-0000-4000-8000-000000000001') is null
  and not exists (
    select 1 from public.b2c_payment_duplicate_groups
    where fingerprint = (select fingerprint from public.b2c_payment_duplicate_groups where id = current_setting('test.b2c_override_group_id')::uuid)
      and status = 'open'
  ),
  'a completed same-fingerprint group with the same member set never reopens'
);

select ok(
  exists (
    select 1 from public.audit_events
    where area = 'b2c_payment_duplicate_group_members' and action = 'insert' and record_id is not null
  )
  and not exists (
    select 1 from public.audit_events
    where area = 'b2c_payment_duplicate_group_members' and record_id is null
  ),
  'duplicate-group member audit events carry a non-null member record ID'
);

-- Product mapping updates a local classification and recomputes the affected
-- payment's duplicate fingerprint.  These calls must remain executable under
-- the Admin's protected function search path, where pgcrypto's digest lives
-- in extensions rather than public.
--
-- First, cross the TypeScript/SQL boundary for both hashes used by the manual
-- transfer write. These literals are generated by PostgreSQL and tracked in
-- tests/fixtures/sql-b2c-hashes.json; the Vitest half computes the same values
-- from tests/b2c-hash-parity-corpus.ts. Calling the real RPC proves the
-- reviewed-input token is accepted by the financial write, while reading the
-- inserted payment proves the real SQL fingerprint output.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select lives_ok(
  $$ select public.record_b2c_manual_bank_transfer(
    'PARITY-REF-1', 'member@playbook.test', 'Ada Founder', 'Membership', null, '266.000000',
    '2026-09-01T08:30:00+03:00', 'Golden parity fixture for a standard transfer.',
    '09e4d8e8311e8497c21978c80a45fb10bf6d5becc6d7910060c8780c4deea891'
  ) $$,
  'the standard PostgreSQL reviewed-input hash is accepted by the real manual-transfer write'
);

select is(
  (select duplicate_fingerprint::text from public.b2c_payments where provider_transaction_id = 'PARITY-REF-1'),
  'f5883d5c6e238ca473483488856c74b43e63e158b309e8b652e300cc141a3c81',
  'the standard manual-transfer SQL fingerprint matches the shared golden fixture'
);

select lives_ok(
  $$ select public.record_b2c_manual_bank_transfer(
    'PARITY-REF-2', 'finance.parity@example.com', 'Maya Al Khalifa', 'WORKSHOP', 'annual', '75.500000',
    '2026-09-02T21:15:00Z', 'Golden parity fixture with a tier and Zulu offset.',
    '836ef405f17f7dd0902023e6af63cf4ca1de530d92f2b8462932a73ab65b115f'
  ) $$,
  'the tier and Zulu-offset PostgreSQL reviewed-input hash is accepted by the real manual-transfer write'
);

select is(
  (select duplicate_fingerprint::text from public.b2c_payments where provider_transaction_id = 'PARITY-REF-2'),
  '6d1621fdc628d42f3c40ab872f0d100d082db44a70404bfec739d54ee1415df1',
  'the tier and Zulu-offset manual-transfer SQL fingerprint matches the shared golden fixture'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint, source_metadata
) values
  ('b4000000-0000-4000-8000-000000000001', 'stripe', 'ch_product_mapping_d14', 'stripe.mapping@playbook.test', 'unmapped', 'failed', 83, 'USD', 1, 83, 83, '2026-08-30 08:00:00+00', '2026-08-30', repeat('4', 64), jsonb_build_object('product_reference', 'price_d14_test')),
  ('b4000000-0000-4000-8000-000000000002', 'tap', 'tap_product_mapping_d15', 'tap.mapping@playbook.test', 'unmapped', 'failed', 97, 'USD', 1, 97, 97, '2026-08-30 09:00:00+00', '2026-08-30', repeat('5', 64), jsonb_build_object('product_reference', 'tap_d15_test'));

select lives_ok(
  $$ select public.apply_stripe_product_mapping('price_d14_test', 'd14_monthly', 'D14 Monthly', 'membership', 'monthly', 'Map the Stripe fixture locally.') $$,
  'Stripe product mapping recomputes an affected payment fingerprint'
);

select ok(
  (select product_mapping_id is not null
      and category_code = 'membership'
      and membership_tier = 'monthly'
      and duplicate_fingerprint <> repeat('4', 64)
      and duplicate_fingerprint ~ '^[0-9a-f]{64}$'
   from public.b2c_payments
   where id = 'b4000000-0000-4000-8000-000000000001'),
  'Stripe mapping persists the local classification and a computed fingerprint'
);

select lives_ok(
  $$ select public.apply_b2c_product_mapping('tap', 'tap_d15_test', 'd15_annual', 'D15 Annual', 'membership', 'annual', 'Map the Tap fixture locally.') $$,
  'Tap product mapping recomputes an affected payment fingerprint'
);

select ok(
  (select product_mapping_id is not null
      and category_code = 'membership'
      and membership_tier = 'annual'
      and duplicate_fingerprint <> repeat('5', 64)
      and duplicate_fingerprint ~ '^[0-9a-f]{64}$'
   from public.b2c_payments
   where id = 'b4000000-0000-4000-8000-000000000002'),
  'Tap mapping persists the local classification and a computed fingerprint'
);

select * from finish();

rollback;
