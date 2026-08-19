begin;

select plan(59);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select has_table('public', 'b2c_payments', 'B2C payments table exists');
select has_table('public', 'b2b_recognised_sales', 'recognised sales table exists separately');
select has_table('public', 'data_coverage', 'coverage table exists for non-zero missing-data states');
select has_table('public', 'operational_targets', 'custom operational targets have a separate table');
select has_table('public', 'operational_target_progress_updates', 'operational progress is append-only');
select has_table('public', 'b2c_finance_imports', 'B2C Finance imports retain source-file provenance');
select has_table('public', 'b2c_finance_staging_rows', 'B2C Finance source rows stay outside reportable payments');
select has_table('public', 'b2c_finance_ledger_posts', 'Approved Finance rows have immutable ledger provenance');

select has_function(
  'public',
  'post_approved_b2c_finance_payments',
  array[]::text[],
  'Approved Finance ledger posting has a protected constructor'
);

select throws_ok(
  $$ select * from public.post_approved_b2c_finance_payments() $$,
  'P0001',
  '%Only an authenticated administrator can post approved B2C Finance payments%',
  'non-Admins cannot post approved Finance rows'
);

select ok(
  exists(
    select 1
    from storage.buckets
    where id = 'b2c-finance-imports'
      and public = false
      and file_size_limit = 10485760
  ),
  'Payment Tracker source files use a private size-limited Storage bucket'
);

select ok(
  exists(
    select 1
    from pg_proc
    where proname = 'finalize_tap_statement_import'
  ),
  'Tap statement evidence has an atomic finalization function'
);

select has_function(
  'public',
  'finalize_stripe_charges_import',
  array['text', 'text', 'text', 'text', 'jsonb'],
  'Stripe Charges evidence has an atomic finalization function'
);

select has_column(
  'public',
  'b2c_provider_evidence',
  'source_entry_key',
  'Stripe refund provenance retains a source entry key'
);

select has_column(
  'public',
  'b2c_provider_evidence',
  'customer_email',
  'Stripe contact email is retained separately from raw evidence'
);

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

select throws_ok(
  $$
    insert into public.b2c_stripe_payment_details (payment_id, enrichment_status)
    values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'complete')
  $$,
  '23514',
  '%linked payment is not a Stripe payment%',
  'Tap payments cannot receive Stripe enrichment details'
);

select has_column(
  'public',
  'b2c_reconciliation_groups',
  'grouping_key',
  'Exact duplicate reconciliation groups retain an idempotency key'
);

select has_function(
  'public',
  'create_b2c_exact_duplicate_groups',
  array[]::text[],
  'Exact duplicate reconciliation groups have a protected constructor'
);

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
  '%operational_target_quantity_unit_check%',
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

select throws_ok(
  $$
    insert into public.operational_target_progress_updates (
      target_id, actual_value, effective_on, evidence_note
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1.000000, '2026-08-11', ' '
    )
  $$,
  '23514',
  '%operational_target_progress_updates_evidence_note_check%',
  'operational progress requires an evidence note'
);

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
  'duplicate Stripe provider ID is rejected'
);

insert into public.b2c_finance_imports (
  id, source_kind, source_file_name, source_file_sha256, source_storage_bucket, source_storage_path
) values (
  'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', 'payment_tracker', 'payment-tracker.xlsx', repeat('a', 64),
  'b2c-imports', 'payment-tracker/a.xlsx'
);

select throws_ok(
  $$
    insert into public.b2c_finance_imports (
      source_kind, source_file_name, source_file_sha256, source_storage_bucket, source_storage_path
    ) values (
      'payment_tracker', 'payment-tracker-copy.xlsx', repeat('a', 64), 'b2c-imports', 'payment-tracker/copy.xlsx'
    )
  $$,
  '23505',
  'identical Finance source-file hash is rejected'
);

select throws_ok(
  $$
    insert into public.b2c_finance_staging_rows (
      import_id, source_tab, source_row_number, raw_payload, reported_date_raw, row_quality
    ) values (
      'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1', 'Other B2C', 2, '{}'::jsonb, '2026-08-01', 'needs_review'
    )
  $$,
  '23514',
  '%b2c_finance_staging_rows_source_tab_check%',
  'unapproved Finance workbook tab is rejected'
);

select throws_ok(
  $$
    insert into public.b2b_companies (source_system, legal_name)
    values ('stripe', 'Stripe must never be B2B')
  $$,
  '23514',
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

select has_table(
  'public',
  'b2c_finance_ledger_adjustments',
  'posted Finance corrections use an append-only adjustment table'
);

select has_view(
  'public',
  'b2c_finance_effective_ledger_entries',
  'effective Finance ledger facts are exposed through a safe view'
);

select has_function(
  'public',
  'apply_b2c_finance_posted_adjustment',
  array['uuid', 'date', 'numeric', 'text', 'text', 'uuid', 'text'],
  'posted Finance adjustment constructor exists'
);

select has_function(
  'public',
  'apply_b2c_finance_posted_adjustment_with_expected_state',
  array['uuid', 'date', 'numeric', 'text', 'text', 'uuid', 'text', 'numeric', 'date'],
  'stale-state-safe posted Finance adjustment wrapper exists'
);

select has_function(
  'public',
  'get_b2c_finance_posted_adjustments_page',
  array['integer', 'integer'],
  'posted Finance adjustment paging function exists'
);

select ok(
  (select relrowsecurity
    from pg_class
    where oid = 'public.b2c_finance_ledger_adjustments'::regclass),
  'RLS is enabled on append-only Finance adjustments'
);

select col_is_unique(
  'public',
  'b2c_finance_ledger_adjustments',
  array['payment_id', 'adjustment_request_id', 'entry_index'],
  'posted Finance adjustment requests are idempotent per entry'
);

-- A replacement Payment Tracker workbook must never repost a payment that a
-- prior import already staged. Every staged row resolves to a stable,
-- content-derived lineage; an Admin decision is required for anything genuinely
-- new, ambiguous, or already represented by a manual bank payment.

select has_table('public', 'b2c_finance_record_lineages', 'B2C Finance lineages have a dedicated table');
select has_table('public', 'b2c_finance_row_lineage_links', 'B2C Finance rows link to a lineage immutably');
select has_table('public', 'b2c_finance_import_version_candidates', 'B2C Finance version-diff candidates are persisted');
select has_table('public', 'b2c_finance_import_version_decisions', 'B2C Finance version-diff decisions are audited');

-- A manual bank transfer reserves its identity; the reservation attributes the acting admin.
insert into public.b2c_payments (
  id, source_system, customer_email, category_code, payment_status,
  original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint, manual_entry_reason
) values (
  'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', 'manual_bank_transfer', 'lineage.manual@playbook.test', 'membership', 'succeeded',
  500.000000, 'USD', 1.0000000000, 500.000000, 500.000000,
  '2026-08-05 09:00:00+00', '2026-08-05', repeat('9', 64), 'Fake manual bank transfer for lineage reservation'
);

select ok(
  (select created_by = '11111111-1111-4111-8111-111111111111'
    from public.b2c_finance_record_lineages
    where represented_payment_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'),
  'the manual bank transfer lineage reservation attributes the acting admin'
);

-- Viewers cannot finalize a Payment Tracker import.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);

select throws_ok(
  $$
    select public.finalize_b2c_finance_import_version(
      p_source_file_name := 'viewer-attempt.xlsx', p_source_file_sha256 := repeat('8', 64),
      p_source_storage_bucket := 'b2c-imports', p_source_storage_path := 'payment-tracker/viewer-attempt.xlsx',
      p_supersedes_import_id := null, p_rows := '[]'::jsonb, p_unchanged := '[]'::jsonb, p_candidates := '[]'::jsonb
    )
  $$,
  'P0001',
  '%Only an authenticated administrator can finalize B2C Finance imports%',
  'a Viewer cannot finalize a B2C Finance import'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- The first-ever Payment Tracker import: one unambiguous new row auto-links,
-- two rows sharing one identity stay ambiguous, and one row matches the
-- manual bank transfer's reserved identity as an existing-payment candidate.
select public.finalize_b2c_finance_import_version(
  p_source_file_name := 'lineage-fixture-one.xlsx',
  p_source_file_sha256 := repeat('e', 64),
  p_source_storage_bucket := 'b2c-imports',
  p_source_storage_path := 'payment-tracker/lineage-fixture-one.xlsx',
  p_supersedes_import_id := null,
  p_rows := jsonb_build_array(
    jsonb_build_object('id', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'sourceTab', 'B2C', 'sourceRowNumber', 2, 'rawPayload', jsonb_build_object(), 'reportedDateRaw', '2026-08-01', 'occurredOn', '2026-08-01', 'amountUsd', '100.000000', 'normalizedCustomerName', 'lineage tester one', 'rowQuality', 'valid'),
    jsonb_build_object('id', 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', 'sourceTab', 'B2C', 'sourceRowNumber', 3, 'rawPayload', jsonb_build_object(), 'reportedDateRaw', '2026-08-02', 'occurredOn', '2026-08-02', 'amountUsd', '200.000000', 'normalizedCustomerName', 'ambiguous tester', 'rowQuality', 'valid'),
    jsonb_build_object('id', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'sourceTab', 'B2C Cons', 'sourceRowNumber', 4, 'rawPayload', jsonb_build_object(), 'reportedDateRaw', '2026-08-02', 'occurredOn', '2026-08-02', 'amountUsd', '200.000000', 'normalizedCustomerName', 'ambiguous tester', 'rowQuality', 'valid'),
    jsonb_build_object('id', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', 'sourceTab', 'B2C', 'sourceRowNumber', 5, 'rawPayload', jsonb_build_object(), 'reportedDateRaw', '2026-08-05', 'occurredOn', '2026-08-05', 'amountUsd', '500.000000', 'normalizedCustomerName', 'existing payment tester', 'rowQuality', 'valid')
  ),
  p_unchanged := '[]'::jsonb,
  p_candidates := jsonb_build_array(
    jsonb_build_object('candidateKind', 'new', 'sourceIdentity', repeat('1', 64), 'financeRowIds', jsonb_build_array('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'), 'priorLineageIds', '[]'::jsonb, 'priorPaymentIds', '[]'::jsonb),
    jsonb_build_object('candidateKind', 'ambiguous', 'sourceIdentity', repeat('2', 64), 'financeRowIds', jsonb_build_array('a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'), 'priorLineageIds', '[]'::jsonb, 'priorPaymentIds', '[]'::jsonb),
    jsonb_build_object(
      'candidateKind', 'existing_payment', 'sourceIdentity', repeat('3', 64),
      'financeRowIds', jsonb_build_array('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4'),
      'priorLineageIds', jsonb_build_array((select id::text from public.b2c_finance_record_lineages where represented_payment_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1')),
      'priorPaymentIds', jsonb_build_array('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1')
    )
  )
);

select ok(
  (select linked_by = '11111111-1111-4111-8111-111111111111' and link_kind = 'initial'
    from public.b2c_finance_row_lineage_links
    where finance_row_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
  'the first-ever import auto-links its one unambiguous new row and attributes the acting admin'
);

select throws_ok(
  $$ update public.b2c_finance_row_lineage_links set link_kind = 'admin_confirmed_new' where finance_row_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' $$,
  'P0001',
  '%is immutable%',
  'a B2C Finance lineage link cannot be updated'
);

select throws_ok(
  $$ delete from public.b2c_finance_row_lineage_links where finance_row_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' $$,
  'P0001',
  '%is immutable%',
  'a B2C Finance lineage link cannot be deleted'
);

select ok(
  not exists (
    select 1 from public.b2c_finance_row_lineage_links
    where finance_row_id in ('a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3')
  ),
  'ambiguous repeated-key rows receive no automatic confirmed lineage'
);

select throws_ok(
  $$
    insert into public.b2c_finance_import_version_decisions (import_id, candidate_id, decision, reason)
    values (
      (select import_id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64)),
      (select id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64)),
      'confirm_new', 'Attempting to confirm an existing-payment candidate as new.'
    )
  $$,
  'P0001',
  '%Only a new candidate can be confirmed%',
  'a bank row matching an existing manual payment cannot be confirmed as a new B2C Finance lineage'
);

-- Viewers cannot record a B2C Finance lineage decision.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);

select throws_ok(
  $$
    insert into public.b2c_finance_import_version_decisions (import_id, candidate_id, decision, reason)
    values (
      (select import_id from public.b2c_finance_import_version_candidates where source_identity = repeat('2', 64) limit 1),
      (select id from public.b2c_finance_import_version_candidates where source_identity = repeat('2', 64) limit 1),
      'confirm_new', 'A Viewer attempting to record a B2C Finance lineage decision.'
    )
  $$,
  'P0001',
  '%Only an authenticated administrator can decide%',
  'a Viewer cannot record a B2C Finance lineage decision'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- An Admin links the workbook row that matches the manual bank transfer as evidence.
insert into public.b2c_finance_import_version_decisions (import_id, candidate_id, decision, target_payment_id, reason)
values (
  (select import_id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64)),
  (select id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64)),
  'link_existing_manual', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
  'Finance confirmed this workbook row is evidence of the existing manual bank transfer.'
);

select ok(
  (select decided_by = '11111111-1111-4111-8111-111111111111'
    from public.b2c_finance_import_version_decisions
    where candidate_id = (select id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64))),
  'the admin-decided B2C Finance lineage decision attributes the acting admin'
);

select ok(
  (select amount_usd = 500.000000::numeric and occurred_on = '2026-08-05'::date and source_system = 'manual_bank_transfer'
    from public.b2c_payments where id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'),
  'linking a workbook row as existing-manual evidence never changes the manual payment amount, date, or source system'
);

select throws_ok(
  $$
    insert into public.b2c_finance_import_version_decisions (import_id, candidate_id, decision, target_payment_id, reason)
    values (
      (select import_id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64)),
      (select id from public.b2c_finance_import_version_candidates where source_identity = repeat('3', 64)),
      'link_existing_manual', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
      'A second, conflicting decision attempt on the same candidate.'
    )
  $$,
  'P0001',
  '%already has a decision%',
  'a second conflicting decision on the same B2C Finance candidate is rejected'
);

-- A replacement import declaring the first as superseded links its unchanged
-- row straight to the same lineage instead of creating a second one.
select public.finalize_b2c_finance_import_version(
  p_source_file_name := 'lineage-fixture-two.xlsx',
  p_source_file_sha256 := repeat('f', 64),
  p_source_storage_bucket := 'b2c-imports',
  p_source_storage_path := 'payment-tracker/lineage-fixture-two.xlsx',
  p_supersedes_import_id := (select id from public.b2c_finance_imports where source_file_sha256 = repeat('e', 64)),
  p_rows := jsonb_build_array(
    jsonb_build_object('id', 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5', 'sourceTab', 'B2C', 'sourceRowNumber', 2, 'rawPayload', jsonb_build_object(), 'reportedDateRaw', '2026-08-01', 'occurredOn', '2026-08-01', 'amountUsd', '100.000000', 'normalizedCustomerName', 'lineage tester one', 'rowQuality', 'valid')
  ),
  p_unchanged := jsonb_build_array(
    jsonb_build_object(
      'financeRowId', 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5',
      'lineageId', (select lineage_id::text from public.b2c_finance_row_lineage_links where finance_row_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1')
    )
  ),
  p_candidates := '[]'::jsonb
);

select is(
  (select lineage_id from public.b2c_finance_row_lineage_links where finance_row_id = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5'),
  (select lineage_id from public.b2c_finance_row_lineage_links where finance_row_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
  'a payment unchanged across two different workbook file hashes shares one lineage'
);

select * from finish();

rollback;
