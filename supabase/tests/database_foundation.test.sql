begin;

select plan(43);

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

select * from finish();

rollback;
