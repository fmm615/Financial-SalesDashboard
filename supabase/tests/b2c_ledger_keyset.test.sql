begin;

select plan(26);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', 'member@playbook.test', 'USD', 100,
    false, false, false, false, false,
    'stripe', date '2026-08-20', date '2026-08-20'
  ),
  jsonb_build_object(
    'source_status', 'succeeded',
    'reconciliation_status', 'not_required',
    'reporting_decision', 'reportable',
    'posting_status', 'not_applicable',
    'exclusion_reasons', '[]'::jsonb,
    'blocking_reasons', '[]'::jsonb
  ),
  'a complete succeeded payment is reportable'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', null, 'USD', 100,
    false, false, false, false, false,
    'stripe', date '2026-08-20', date '2026-08-20'
  )->'blocking_reasons',
  '["missing_customer_email"]'::jsonb,
  'missing email is blocked without an audited exception'
);

select is(
  public.b2c_payment_decision_reasons(
    'failed', 'member@playbook.test', 'USD', 100,
    false, false, false, false, false,
    'tap', date '2026-08-20', date '2026-08-20'
  )->'blocking_reasons',
  '["failed_payment"]'::jsonb,
  'failed status has the exact decision reason'
);

select is(
  public.b2c_payment_decision_reasons(
    'pending', 'member@playbook.test', 'USD', 100,
    false, false, false, false, false,
    'tap', date '2026-08-20', date '2026-08-20'
  )->'blocking_reasons',
  '["pending_payment"]'::jsonb,
  'pending status has the exact decision reason'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', 'member@playbook.test', 'BHD', null,
    true, false, false, false, false,
    'tap', date '2026-08-20', date '2026-08-20'
  )->'blocking_reasons',
  '["missing_fx"]'::jsonb,
  'Finance exception never waives missing FX'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', 'member@playbook.test', 'USD', null,
    false, false, false, false, false,
    'stripe', date '2026-08-20', date '2026-08-20'
  )->'blocking_reasons',
  '["missing_amount"]'::jsonb,
  'missing USD amount is distinct from missing FX'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', null, 'USD', 100,
    true, false, false, false, false,
    'stripe', date '2026-08-20', date '2026-08-20'
  )->>'reporting_decision',
  'exception_included',
  'an audited Finance exception waives only missing email'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', null, 'USD', 100,
    false, true, false, false, false,
    'finance_tracker', date '2026-08-20', date '2026-08-20'
  ),
  jsonb_build_object(
    'source_status', 'succeeded',
    'reconciliation_status', 'not_required',
    'reporting_decision', 'reportable',
    'posting_status', 'posted',
    'exclusion_reasons', '[]'::jsonb,
    'blocking_reasons', '[]'::jsonb
  ),
  'immutable Finance Tracker provenance permits missing email and remains posted'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', 'member@playbook.test', 'USD', 100,
    false, false, true, false, false,
    'manual_bank_transfer', date '2026-08-20', date '2026-08-20'
  )->'blocking_reasons',
  '["possible_duplicate"]'::jsonb,
  'an open payment duplicate is blocking and reconciliation-pending'
);

select is(
  public.b2c_payment_decision_reasons(
    'succeeded', 'member@playbook.test', 'USD', 100,
    false, false, false, true, true,
    'stripe', date '2026-08-22', date '2026-08-20'
  ),
  jsonb_build_object(
    'source_status', 'succeeded',
    'reconciliation_status', 'not_required',
    'reporting_decision', 'excluded',
    'posting_status', 'not_applicable',
    'exclusion_reasons', '["duplicate_exclusion","needs_follow_up"]'::jsonb,
    'blocking_reasons', '["implausible_future_date","duplicate_exclusion","other_open_review"]'::jsonb
  ),
  'ordered blockers preserve future date, duplicate exclusion, and open review'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, customer_name,
  category_code, payment_status, original_amount, original_currency,
  exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('91000000-0000-4000-8000-000000000001', 'stripe', 'keyset-moved-in', 'moved.in@playbook.test', 'Moved In', 'membership', 'succeeded', 11, 'USD', 1, 11, 11, '2026-07-30 10:00:00+00', '2026-07-30', repeat('1', 64)),
  ('91000000-0000-4000-8000-000000000002', 'stripe', 'keyset-moved-out', 'moved.out@playbook.test', 'Moved Out', 'membership', 'succeeded', 12, 'USD', 1, 12, 12, '2026-08-15 10:00:00+00', '2026-08-15', repeat('2', 64)),
  ('91000000-0000-4000-8000-000000000003', 'stripe', 'keyset-tie-a', 'tie.a@playbook.test', 'Tie A', 'course', 'succeeded', 13, 'USD', 1, 13, 13, '2026-08-20 10:00:00+00', '2026-08-20', repeat('3', 64)),
  ('91000000-0000-4000-8000-000000000004', 'stripe', 'keyset-tie-b', 'tie.b@playbook.test', 'Tie B', 'course', 'succeeded', 13, 'USD', 1, 13, 13, '2026-08-20 11:00:00+00', '2026-08-20', repeat('4', 64));

insert into public.b2c_payment_local_overrides (
  payment_id, local_occurred_on, created_by, updated_by
) values
  ('91000000-0000-4000-8000-000000000001', '2026-08-10', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('91000000-0000-4000-8000-000000000002', '2026-07-10', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111');

select is(
  (select count(*)::integer from public.get_b2c_ledger_page(
    p_period => '2026-08', p_today => '2026-08-31', p_limit => 100,
    p_sort => 'date_desc', p_search => 'keyset-moved-in'
  )),
  1,
  'a local date correction moves a raw out-of-period payment into the period'
);

select is(
  (select count(*)::integer from public.get_b2c_ledger_page(
    p_period => '2026-08', p_today => '2026-08-31', p_limit => 100,
    p_sort => 'date_desc', p_search => 'keyset-moved-out'
  )),
  0,
  'a local date correction moves a raw in-period payment out of the period'
);

select is(
  public.get_b2c_ledger_metadata(
    p_period => '2026-08', p_today => '2026-08-31',
    p_search => 'keyset-tie'
  )->>'total_count',
  '2',
  'metadata computes an exact active-filter count in PostgreSQL'
);

select is(
  public.get_b2c_ledger_metadata(
    p_period => 'all', p_today => '2026-09-30',
    p_search => 'keyset_%'
  )->>'total_count',
  '0',
  'search treats SQL wildcard characters as literal text'
);

select is(
  (
    select jsonb_agg(record_id order by record_id)
    from public.get_b2c_ledger_page(
      p_period => '2026-08', p_today => '2026-08-31', p_limit => 2,
      p_sort => 'amount_desc', p_search => 'keyset-tie'
    )
  ),
  '["91000000-0000-4000-8000-000000000003","91000000-0000-4000-8000-000000000004"]'::jsonb,
  'equal sort values use record kind and UUID as deterministic tie-breakers'
);

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, customer_email, customer_name,
  category_code, payment_status, original_amount, original_currency,
  exchange_rate_to_usd, amount_usd, gross_amount_usd,
  occurred_at, occurred_on, duplicate_fingerprint
) values
  ('92000000-0000-4000-8000-000000000001', 'stripe', 'summary-clean', 'summary.clean@playbook.test', 'Summary Clean', 'membership', 'succeeded', 100, 'USD', 1, 100, 100, '2026-09-01 10:00:00+00', '2026-09-01', repeat('5', 64)),
  ('92000000-0000-4000-8000-000000000002', 'stripe', 'summary-override', 'summary.override@playbook.test', 'Summary Override', 'membership', 'succeeded', 50, 'USD', 1, 50, 50, '2026-09-02 10:00:00+00', '2026-09-02', repeat('6', 64)),
  ('92000000-0000-4000-8000-000000000003', 'stripe', 'summary-missing-email', null, 'Summary Missing', 'membership', 'succeeded', 30, 'USD', 1, 30, 30, '2026-09-03 10:00:00+00', '2026-09-03', repeat('7', 64)),
  ('92000000-0000-4000-8000-000000000004', 'tap', 'summary-failed', 'summary.failed@playbook.test', 'Summary Failed', 'membership', 'failed', 40, 'USD', 1, 40, 40, '2026-09-04 10:00:00+00', '2026-09-04', repeat('8', 64)),
  ('92000000-0000-4000-8000-000000000005', 'tap', 'summary-foreign', 'summary.fx@playbook.test', 'Summary FX', 'membership', 'succeeded', 10, 'BHD', null, null, null, '2026-09-05 10:00:00+00', '2026-09-05', repeat('9', 64)),
  ('92000000-0000-4000-8000-000000000006', 'stripe', 'summary-exception', null, 'Summary Exception', 'membership', 'succeeded', 20, 'USD', 1, 20, 20, '2026-09-06 10:00:00+00', '2026-09-06', repeat('a', 64));

insert into public.b2c_payment_local_overrides (
  payment_id, local_amount_usd, created_by, updated_by
) values (
  '92000000-0000-4000-8000-000000000002', 60,
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111'
);

insert into public.b2c_stripe_payment_details (
  payment_id, payment_method_customer_email, enrichment_status
) values (
  '92000000-0000-4000-8000-000000000003',
  'fallback.context@playbook.test',
  'complete'
);

insert into public.b2c_payment_finance_exception_decisions (
  payment_id, decision, reason, confirmed_provider_transaction,
  confirmed_no_known_duplicate, created_by
) values (
  '92000000-0000-4000-8000-000000000006', 'include',
  'Finance verified this unique source payment.', true, true,
  '11111111-1111-4111-8111-111111111111'
);

insert into public.b2c_refunds (
  id, payment_id, source_system, provider_refund_id, original_amount,
  original_currency, exchange_rate_to_usd, amount_usd, occurred_at
) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'stripe', 'summary-refund-eligible', 10, 'USD', 1, 10, '2026-09-07 10:00:00+00'),
  ('93000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000003', 'stripe', 'summary-refund-ineligible', 5, 'USD', 1, 5, '2026-09-08 10:00:00+00');

select is(
  public.get_b2c_dashboard_summary('2026-09', '2026-09-30')->>'eligible_payments_usd',
  '180.000000',
  'summary totals use effective payment USD amounts'
);

select is(
  public.get_b2c_dashboard_summary('2026-09', '2026-09-30')->>'completed_source_payments_usd',
  '200.000000',
  'source volume uses retained source USD rather than a local override'
);

select is(
  public.get_b2c_dashboard_summary('2026-09', '2026-09-30')->>'refunds_usd',
  '10.000000',
  'only refunds linked to a reportable payment reduce the financial total'
);

select is(
  public.get_b2c_dashboard_summary('2026-09', '2026-09-30')->'calculation',
  jsonb_build_object(
    'completed_source_payment_count', 5,
    'reportable_payment_count', 3,
    'excluded_completed_payment_count', 2,
    'excluded_completed_payments_usd', '30.000000',
    'source_refund_count', 2,
    'eligible_refund_count', 1,
    'missing_customer_email_count', 1,
    'possible_duplicate_count', 0,
    'other_review_count', 0,
    'non_succeeded_payment_count', 1,
    'finance_exception_payment_count', 1
  ),
  'summary returns exact period counts without materializing Ledger rows in TypeScript'
);

select is(
  (
    select value -> 'decision' ->> 'reporting_decision'
    from jsonb_array_elements(public.get_b2c_ledger_decisions('2026-09-30'))
    where value ->> 'record_type' = 'Payment'
      and value ->> 'record_id' = '92000000-0000-4000-8000-000000000003'
  ),
  'blocked',
  'the Work queue receives the canonical SQL decision for every payment'
);

select is(
  (
    select decision ->> 'reporting_decision'
    from public.get_b2c_ledger_page(
      p_period => '2026-09', p_today => '2026-09-30', p_limit => 100,
      p_sort => 'date_desc', p_search => 'summary-missing-email'
    )
  ),
  'blocked',
  'non-transaction Stripe fallback email is display context and never satisfies reportability'
);

select is(
  (select count(*)::integer from public.get_b2c_ledger_rows(
    array['91000000-0000-4000-8000-000000000001'::uuid],
    array[]::uuid[],
    '2026-08-31'
  )),
  1,
  'page hydration returns only explicitly requested payment identities'
);

select is(
  (
    select row_data ->> 'date_value'
    from public.get_b2c_ledger_rows(
      array['91000000-0000-4000-8000-000000000001'::uuid],
      array[]::uuid[],
      '2026-08-31'
    )
  ),
  '2026-08-10',
  'page hydration exposes the corrected effective date for the requested payment'
);

select is(
  (
    select row_data ->> 'has_finance_exception'
    from public.get_b2c_ledger_rows(
      array['91000000-0000-4000-8000-000000000001'::uuid],
      array[]::uuid[],
      '2026-08-31'
    )
  ),
  'false',
  'page hydration returns false rather than null when no Finance exception exists'
);

select is(
  public.get_b2c_payment_evidence('92000000-0000-4000-8000-000000000001')->>'payment_id',
  '92000000-0000-4000-8000-000000000001',
  'payment evidence is scoped to the requested payment ID'
);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
select throws_ok(
  $$ select public.get_b2c_payment_evidence('92000000-0000-4000-8000-000000000001') $$,
  'P0001',
  'Admin access is required',
  'a Viewer cannot read full payment evidence'
);

select * from finish();

rollback;
