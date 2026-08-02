begin;

select plan(12);

select has_table('public', 'b2c_payments', 'B2C payments table exists');
select has_table('public', 'b2b_recognised_sales', 'recognised sales table exists separately');
select has_table('public', 'data_coverage', 'coverage table exists for non-zero missing-data states');

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

select isnt(
  (select booking_amount_usd from public.b2b_bookings where id = '13131313-1313-4313-8313-131313131313'),
  (select recognised_amount_usd from public.b2b_recognised_sales where id = '14141414-1414-4414-8414-141414141414'),
  'booking and recognised sales are not the same stored amount'
);

select ok(
  (select exists (
    select 1 from public.audit_events
    where actor_profile_id = '11111111-1111-4111-8111-111111111111'
      and area = 'b2b_recognised_sales'
  )),
  'manual recognised-sales entry has an individual audit actor'
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
