begin;

select plan(16);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select has_table('public', 'b2c_payments', 'B2C payments table exists');
select has_table('public', 'b2b_recognised_sales', 'recognised sales table exists separately');
select has_table('public', 'data_coverage', 'coverage table exists for non-zero missing-data states');
select has_table('public', 'operational_targets', 'custom operational targets have a separate table');
select has_table('public', 'operational_target_progress_updates', 'operational progress is append-only');

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

select * from finish();

rollback;
