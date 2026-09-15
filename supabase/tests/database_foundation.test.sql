begin;

select plan(50);

-- Seeded Fatema is an Admin; seeded Wafa is a Viewer.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- 1-9: clean schema, audit, and security foundations.
select has_table('public', 'b2c_payments', 'B2C payments are present in the clean schema');
select has_table('public', 'b2b_deals', 'B2B deals are present in the clean schema');
select has_table('public', 'financial_corrections', 'append-only financial corrections are present');
select has_table('public', 'operational_targets', 'operational targets are separate from financial targets');
select has_table('public', 'report_jobs', 'durable report jobs are present');
select is((select count(*)::integer from pg_trigger where not tgisinternal and tgname like 'audit_%'), 36, 'the cross-domain sweep attaches all 36 audit triggers');
select ok(not exists (
  select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public' and relation.relkind = 'r'
    and relation.relname in ('b2c_payments', 'b2b_deals', 'financial_corrections', 'review_flags', 'audit_events', 'report_jobs')
    and not relation.relrowsecurity
), 'representative financial, review, audit, and report tables have RLS enabled');
select ok(not exists (
  select 1 from pg_constraint constraint_row join pg_attribute attribute_row
    on attribute_row.attrelid = constraint_row.conrelid and attribute_row.attnum = any(constraint_row.conkey)
  where constraint_row.contype = 'f' and (
    (constraint_row.conrelid = 'public.financial_corrections'::regclass and attribute_row.attname = 'target_record_id')
    or (constraint_row.conrelid = 'public.review_flags'::regclass and attribute_row.attname = 'source_record_id')
  )
), 'correction and review references stay polymorphic without domain foreign keys');
select ok((select not public from storage.buckets where id = 'report-archives'), 'report archives use a private storage bucket');

-- 10-27: B2C integrity, manual transfers, duplicate workflow, FX, exceptions.
select throws_ok($$
  insert into public.b2c_payments (source_system, provider_transaction_id, customer_email, category_code, payment_status, original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint)
  values ('stripe', 'pi_test_001', 'duplicate@playbook.test', 'membership', 'succeeded', 100, 'USD', 1, 100, 100, '2027-01-01 10:00:00+00', '2027-01-01', repeat('a', 64))
$$, '23505', null, 'provider transaction identifiers remain idempotent');
select throws_ok($$
  insert into public.b2c_payments (source_system, provider_transaction_id, customer_email, category_code, payment_status, original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint)
  values ('stripe', 'ch_foreign_with_invented_usd', 'foreign@playbook.test', 'membership', 'succeeded', 50, 'BHD', 2.65, 132.5, 132.5, '2027-01-02 10:00:00+00', '2027-01-02', repeat('b', 64))
$$, '23514', null, 'foreign provider payments cannot invent USD at ingestion');
select is((select amount_usd from public.b2c_payments where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'), 100::numeric, 'a linked partial refund leaves the original payment unchanged');
select throws_ok($$
  insert into public.b2c_refunds (payment_id, source_system, provider_refund_id, original_amount, original_currency, exchange_rate_to_usd, amount_usd, occurred_at)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'stripe', 're_overage_clean_suite', 76, 'USD', 1, 76, '2027-01-03 10:00:00+00')
$$, 'P0001', 'Refund total cannot exceed original payment amount', 'refunds cannot exceed the linked payment total');

insert into public.b2c_payments (id, source_system, provider_transaction_id, customer_email, category_code, payment_status, original_amount, original_currency, occurred_at, occurred_on, duplicate_fingerprint)
values ('a1000000-0000-4000-8000-000000000001', 'tap', 'tap_foreign_override', 'fx.local@playbook.test', 'membership', 'succeeded', 20, 'BHD', '2027-01-04 10:00:00+00', '2027-01-04', repeat('c', 64));
select throws_ok($$
  insert into public.b2c_payment_local_overrides (payment_id, local_amount_usd, created_by, updated_by)
  values ('a1000000-0000-4000-8000-000000000001', 53.2, '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111')
$$, 'P0001', 'A foreign-currency payment requires a Finance-approved FX conversion; do not enter a local USD amount directly', 'a local correction cannot manufacture USD for a foreign provider payment');

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
set local role authenticated;
select throws_ok($$
  select public.record_b2c_manual_bank_transfer('VIEWER-REF', 'viewer@playbook.test', 'Viewer', 'membership', null, '125.000000', '2027-01-05T08:00:00+03:00', 'Viewer attempt.', repeat('0', 64))
$$, 'P0001', 'Only an authenticated administrator can record a manual bank transfer', 'a Viewer cannot record a manual bank transfer');
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select public.record_b2c_manual_bank_transfer(
  'MANUAL-CLEAN-1', 'bank.member@playbook.test', 'Bank Member', 'membership', null, '150.000000', '2027-01-05T08:00:00+03:00', 'Confirmed clean bank transfer.',
  encode(extensions.digest('MANUAL-CLEAN-1|bank.member@playbook.test|Bank Member|membership||150.000000|2027-01-05T08:00:00+03:00|Confirmed clean bank transfer.', 'sha256'), 'hex')
);
select ok((select source_system = 'manual_bank_transfer' and original_currency = 'USD' and exchange_rate_to_usd = 1 and entered_by = '11111111-1111-4111-8111-111111111111'::uuid from public.b2c_payments where provider_transaction_id = 'MANUAL-CLEAN-1'), 'a clean manual transfer records USD-only facts and the Admin actor');
select is((select occurred_on from public.b2c_payments where provider_transaction_id = 'MANUAL-CLEAN-1'), '2027-01-05'::date, 'the manual transfer stores its Bahrain business date');
select throws_ok($$
  select public.record_b2c_manual_bank_transfer('MANUAL-CLEAN-1', 'bank.member@playbook.test', 'Bank Member', 'membership', null, '150.000000', '2027-01-05T08:00:00+03:00', 'A second confirmation.', encode(extensions.digest('MANUAL-CLEAN-1|bank.member@playbook.test|Bank Member|membership||150.000000|2027-01-05T08:00:00+03:00|A second confirmation.', 'sha256'), 'hex'))
$$, 'P0001', 'A manual bank transfer with this reference already exists', 'an exact manual bank reference is rejected outright');
select throws_ok($$
  select public.record_b2c_manual_bank_transfer('MANUAL-STALE-1', 'stale@playbook.test', 'Stale Member', 'membership', null, '90.000000', '2027-01-05T09:00:00+03:00', 'Reviewed details changed.', repeat('f', 64))
$$, 'P0001', 'The reviewed bank transfer details changed since preview. Start again.', 'a stale manual-transfer review hash fails before a write');

insert into public.b2c_payments (id, source_system, provider_transaction_id, customer_email, category_code, payment_status, original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint)
values ('a2000000-0000-4000-8000-000000000001', 'stripe', 'ch_manual_content_candidate', 'content.duplicate@playbook.test', 'membership', 'succeeded', 75, 'USD', 1, 75, 75, '2027-01-06 08:00:00+00', '2027-01-06', repeat('d', 64));
select public.record_b2c_manual_bank_transfer(
  'MANUAL-CONTENT-1', 'content.duplicate@playbook.test', 'Different Name', 'membership', null, '75.000000', '2027-01-06T12:00:00+03:00', 'Retain possible duplicate for review.',
  encode(extensions.digest('MANUAL-CONTENT-1|content.duplicate@playbook.test|Different Name|membership||75.000000|2027-01-06T12:00:00+03:00|Retain possible duplicate for review.', 'sha256'), 'hex')
);
select ok(
  exists (select 1 from public.b2c_payments where provider_transaction_id = 'MANUAL-CONTENT-1')
  and exists (select 1 from public.review_flags flag join public.b2c_payments payment on payment.id = flag.source_record_id where payment.provider_transaction_id = 'MANUAL-CONTENT-1' and flag.flag_type = 'possible_duplicate' and flag.status = 'open')
  and exists (select 1 from public.b2c_payment_duplicate_group_members member join public.b2c_payments payment on payment.id = member.payment_id where payment.provider_transaction_id = 'MANUAL-CONTENT-1'),
  'a content-duplicate manual transfer is retained and put in the protected duplicate workflow'
);
select throws_ok($$
  select public.resolve_b2c_review_flag(
    (select flag.id from public.review_flags flag join public.b2c_payments payment on payment.id = flag.source_record_id where payment.provider_transaction_id = 'MANUAL-CONTENT-1' and flag.status = 'open'),
    'resolved', 'Generic review resolution must not decide a payment duplicate.'
  )
$$, 'P0001', 'Possible duplicates must be decided through the dedicated duplicate workflow', 'a generic B2C resolution cannot clear a payment duplicate');
select set_config('test.manual_content_group', (select member.group_id::text from public.b2c_payment_duplicate_group_members member join public.b2c_payments payment on payment.id = member.payment_id where payment.provider_transaction_id = 'MANUAL-CONTENT-1'), true);
select lives_ok($$
  select public.resolve_b2c_payment_duplicate_group(current_setting('test.manual_content_group')::uuid, 'keep_one', (select id from public.b2c_payments where provider_transaction_id = 'MANUAL-CONTENT-1'), 'Finance confirmed the manual bank transfer is the retained payment.')
$$, 'an Admin can resolve a B2C duplicate group atomically');
select ok(
  (select status = 'resolved' and decision = 'keep_one' from public.b2c_payment_duplicate_groups where id = current_setting('test.manual_content_group')::uuid)
  and (select count(*) = 1 from public.b2c_payment_duplicate_group_members where group_id = current_setting('test.manual_content_group')::uuid and decision = 'include')
  and (select count(*) = 1 from public.b2c_payment_duplicate_group_members where group_id = current_setting('test.manual_content_group')::uuid and decision = 'exclude')
  and not exists (select 1 from public.review_flags flag join public.b2c_payment_duplicate_group_members member on member.payment_id = flag.source_record_id where member.group_id = current_setting('test.manual_content_group')::uuid and flag.flag_type = 'possible_duplicate' and flag.status = 'open'),
  'a keep-one decision records member outcomes and resolves corresponding flags'
);
select is(public.record_b2c_payment_fx_conversion('a1000000-0000-4000-8000-000000000001', 2.5, 'Finance spot rate', '2027-01-07', 'Approved conversion for a retained foreign provider payment.'), 50::numeric, 'payment FX conversion calculates USD from the immutable source amount');
select ok(
  exists (select 1 from public.b2c_payment_fx_conversions where payment_id = 'a1000000-0000-4000-8000-000000000001' and amount_usd = 50)
  and exists (select 1 from public.financial_corrections where target_area = 'b2c_payment' and target_record_id = 'a1000000-0000-4000-8000-000000000001'::uuid and after_value ->> 'amount_usd' = '50.000000'),
  'payment FX conversion appends conversion evidence and a financial correction'
);
insert into public.b2c_payments (id, source_system, provider_transaction_id, customer_email, category_code, payment_status, original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint)
values
  ('a3000000-0000-4000-8000-000000000001', 'stripe', 'ch_exception_ok', null, 'unmapped', 'succeeded', 120, 'USD', 1, 120, 120, '2027-01-08 08:00:00+00', '2027-01-08', repeat('e', 64)),
  ('a3000000-0000-4000-8000-000000000002', 'tap', 'tap_exception_failed', null, 'unmapped', 'failed', 120, 'USD', 1, 120, 120, '2027-01-08 09:00:00+00', '2027-01-08', repeat('f', 64));
select lives_ok($$ select public.include_b2c_payment_with_finance_exception('a3000000-0000-4000-8000-000000000001', 'Finance verified the unique USD payment without provider email.', true, true) $$, 'an eligible unmapped provider payment can receive a documented Finance exception');
select throws_ok($$ select public.include_b2c_payment_with_finance_exception('a3000000-0000-4000-8000-000000000002', 'A failed source payment cannot become reportable.', true, true) $$, 'P0001', 'Only a succeeded provider payment can be included by Finance exception', 'a failed provider payment cannot receive a Finance exception');

-- 28-36: B2B corrections, recognised sales, and duplicate workflow.
insert into public.b2b_companies (id, source_system, external_company_id, legal_name)
values ('b1000000-0000-4000-8000-000000000001', 'hubspot', 'hs-company-clean-1', 'Clean Suite Company');
insert into public.b2b_deals (id, company_id, source_system, external_deal_id, name, stage_code, financial_status, hubspot_close_date)
values ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'hubspot', 'hs-incomplete-clean-1', 'Incomplete closed-won deal', 'closed_won', 'needs_review', '2027-02-01');
select throws_ok($$
  insert into public.b2b_bookings (deal_id, source_system, booking_date, original_amount, original_currency, exchange_rate_to_usd, booking_amount_usd)
  values ('b2000000-0000-4000-8000-000000000001', 'hubspot', '2027-02-01', 100, 'USD', 1, 100)
$$, 'P0001', 'A booking cannot be created for a B2B deal with incomplete financial data', 'an incomplete HubSpot deal cannot create a booking');
select lives_ok($$ select public.apply_hubspot_deal_financial_correction('b2000000-0000-4000-8000-000000000001', 100, 'USD', 1, 'Finance verified the original contract amount.') $$, 'a HubSpot financial correction completes an eligible source deal');
select ok(
  (select financial_status = 'complete' and pipeline_amount_usd = 100 from public.b2b_deals where id = 'b2000000-0000-4000-8000-000000000001')
  and exists (select 1 from public.b2b_bookings where deal_id = 'b2000000-0000-4000-8000-000000000001' and booking_amount_usd = 100),
  'a corrected closed-won HubSpot deal receives its separate booking'
);
select ok(exists (select 1 from public.financial_corrections where target_area = 'b2b_deal' and target_record_id = 'b2000000-0000-4000-8000-000000000001' and created_by = '11111111-1111-4111-8111-111111111111'::uuid), 'HubSpot financial corrections retain the authenticated actor');
insert into public.b2b_recognised_sales (deal_id, booking_id, recognised_amount, original_currency, exchange_rate_to_usd, recognised_amount_usd, recognition_date, reporting_period, reason_or_reference, entered_by)
values ('b2000000-0000-4000-8000-000000000001', (select id from public.b2b_bookings where deal_id = 'b2000000-0000-4000-8000-000000000001'), 40, 'USD', 1, 0, '2027-02-02', '2027-02-01', 'First recognised portion.', '11111111-1111-4111-8111-111111111111');
select is((select recognised_amount_usd from public.b2b_recognised_sales where deal_id = 'b2000000-0000-4000-8000-000000000001'), 40::numeric, 'recognised-sales USD is calculated by the database trigger');
select throws_ok($$
  insert into public.b2b_recognised_sales (deal_id, recognised_amount, original_currency, exchange_rate_to_usd, recognised_amount_usd, recognition_date, reporting_period, reason_or_reference, entered_by)
  values ('b2000000-0000-4000-8000-000000000001', 70, 'USD', 1, 0, '2027-02-03', '2027-02-01', 'Would exceed the approved deal.', '11111111-1111-4111-8111-111111111111')
$$, 'P0001', 'Recognised sales cannot exceed the linked deal USD amount', 'recognised sales cannot exceed the linked deal amount');
insert into public.b2b_deals (id, company_id, source_system, external_deal_id, name, stage_code, financial_status, pipeline_original_amount, original_currency, exchange_rate_to_usd, pipeline_amount_usd, hubspot_close_date)
values
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'hubspot', 'hs-duplicate-clean-1', 'Duplicate candidate', 'proposal', 'complete', 55, 'USD', 1, 55, '2027-02-10'),
  ('b2000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'hubspot', 'hs-duplicate-clean-2', 'Duplicate candidate', 'proposal', 'complete', 55, 'USD', 1, 55, '2027-02-10');
select public.flag_hubspot_possible_duplicates('b2000000-0000-4000-8000-000000000002');
select set_config('test.b2b_duplicate_group', (select id::text from public.b2b_duplicate_groups where status = 'open' and fingerprint = md5('duplicate candidate|proposal|55.000000|2027-02-10')), true);
select ok(
  exists (select 1 from public.b2b_duplicate_groups where id = current_setting('test.b2b_duplicate_group')::uuid)
  and (select count(*) = 2 from public.review_flags where source_area = 'b2b_deal' and flag_type = 'possible_duplicate' and status = 'open' and source_record_id in ('b2000000-0000-4000-8000-000000000002'::uuid, 'b2000000-0000-4000-8000-000000000003'::uuid)),
  'HubSpot duplicate detection opens a group and flags both candidates'
);
select lives_ok($$ select public.resolve_hubspot_duplicate_group(current_setting('test.b2b_duplicate_group')::uuid, 'keep_one', 'b2000000-0000-4000-8000-000000000002', 'Finance retained the first confirmed HubSpot deal.') $$, 'an Admin can resolve a HubSpot duplicate group');
select ok(
  (select duplicate_review_status = 'include' from public.b2b_deals where id = 'b2000000-0000-4000-8000-000000000002')
  and (select duplicate_review_status = 'exclude' from public.b2b_deals where id = 'b2000000-0000-4000-8000-000000000003')
  and not exists (select 1 from public.reportable_b2b_deals where id = 'b2000000-0000-4000-8000-000000000003'),
  'the B2B duplicate decision retains one candidate and excludes the other from reporting'
);

insert into public.integration_errors (id, provider, safe_error_summary, source_reference)
values ('b3000000-0000-4000-8000-000000000001', 'hubspot', 'HubSpot fixture needs review.', 'HubSpot deal hs-incomplete-clean-1 — source incomplete');
insert into public.review_flags (source_area, source_record_id, flag_type, priority, reason)
values ('integration', 'b3000000-0000-4000-8000-000000000001', 'needs_follow_up', 2, 'HubSpot fixture needs review.');
select lives_ok($$ select public.resolve_hubspot_integration_error('b3000000-0000-4000-8000-000000000001', 'Finance confirmed the recorded HubSpot correction.') $$, 'HubSpot integration errors have a protected resolution workflow');

-- 38-46: immutable target definitions and append-only operational evidence.
select throws_ok($$
  insert into public.operational_targets (display_name, value_kind, target_value, unit_label, period_start, period_end, finance_reference, revision_reason)
  values ('Unitless quantity', 'quantity', 10, null, '2027-01-01', '2027-12-31', 'Plan', 'Initial definition')
$$, '23514', null, 'quantity operational targets require a unit label');
insert into public.operational_targets (id, display_name, value_kind, target_value, unit_label, period_start, period_end, status, finance_reference, revision_reason)
values ('c1000000-0000-4000-8000-000000000001', 'Qualified leads', 'quantity', 100, 'leads', '2027-01-01', '2027-12-31', 'active', 'Operations plan', 'Initial approved target');
select set_config('test.operational_lineage', (select target_lineage_id::text from public.operational_targets where id = 'c1000000-0000-4000-8000-000000000001'), true);
select ok(public.revise_operational_target('c1000000-0000-4000-8000-000000000001', 'Qualified leads', 'quantity', 125, 'leads', '2027-01-01', '2027-12-31', 'Revised operations plan', 'Demand plan changed') is not null, 'operational target revision returns a successor ID');
select ok(
  (select status = 'archived' and archived_at is not null from public.operational_targets where id = 'c1000000-0000-4000-8000-000000000001')
  and (select revision_number = 2 and target_value = 125 from public.operational_targets where target_lineage_id = current_setting('test.operational_lineage')::uuid and status = 'active'),
  'operational revision atomically archives the prior definition and activates its successor'
);
select throws_ok($$
  update public.operational_targets set target_value = 150
  where id = (select id from public.operational_targets where target_lineage_id = current_setting('test.operational_lineage')::uuid and status = 'active')
$$, 'P0001', 'Active target definitions must be revised, not overwritten', 'active operational targets cannot be overwritten in place');
select throws_ok($$
  insert into public.operational_target_progress_updates (target_id, actual_value, effective_on, evidence_note)
  values ('c1000000-0000-4000-8000-000000000001', 1, '2027-02-01', 'Attempt against archived target.')
$$, 'P0001', 'Operational progress requires an active target', 'operational progress requires an active target');
insert into public.operational_target_progress_updates (target_id, actual_value, effective_on, evidence_note)
select id, 24, '2027-02-01', 'CRM export verified 24 qualified leads.'
from public.operational_targets
where target_lineage_id = current_setting('test.operational_lineage')::uuid and status = 'active';
select ok(exists (
  select 1 from public.operational_target_progress_updates
  where actual_value = 24 and evidence_note = 'CRM export verified 24 qualified leads.'
    and entered_by = '11111111-1111-4111-8111-111111111111'::uuid
), 'operational progress retains dated evidence and the authenticated actor');
select is((select array_agg(cmd order by cmd) from pg_policies where schemaname = 'public' and tablename = 'operational_target_progress_updates'), array['INSERT', 'SELECT']::text[], 'operational progress has no update or delete policy and remains append-only');
insert into public.financial_targets (id, metric_code, period_start, period_end, target_amount_usd, status, finance_reference, revision_reason)
values ('c2000000-0000-4000-8000-000000000001', 'b2c_cash_received', '2027-01-01', '2027-01-31', 1000, 'active', 'Finance plan', 'Initial approved target');
select set_config('test.financial_lineage', (select target_lineage_id::text from public.financial_targets where id = 'c2000000-0000-4000-8000-000000000001'), true);
select ok(public.revise_financial_target('c2000000-0000-4000-8000-000000000001', 'b2c_cash_received', '2027-01-01', '2027-01-31', 1250, 'Updated finance plan', 'January target revised') is not null, 'financial target revision returns a successor ID');
select ok(
  (select status = 'archived' and archived_at is not null from public.financial_targets where id = 'c2000000-0000-4000-8000-000000000001')
  and (select revision_number = 2 and target_amount_usd = 1250 from public.financial_targets where target_lineage_id = current_setting('test.financial_lineage')::uuid and status = 'active'),
  'financial revision atomically archives the prior definition and activates its successor'
);

-- 47-50: retained review history, audit immutability, Viewer RLS, report state.
insert into public.review_flags (id, source_area, source_record_id, flag_type, priority, reason)
values ('d1000000-0000-4000-8000-000000000001', 'b2c_payment', 'a3000000-0000-4000-8000-000000000001', 'needs_follow_up', 3, 'Confirm the retained provider source evidence.');
insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
values ('d1000000-0000-4000-8000-000000000001', 'resolved', 'Finance confirmed the retained provider evidence.');
select ok(
  (select status = 'resolved' and resolved_by = '11111111-1111-4111-8111-111111111111'::uuid from public.review_flags where id = 'd1000000-0000-4000-8000-000000000001')
  and exists (select 1 from public.review_flag_resolutions where flag_id = 'd1000000-0000-4000-8000-000000000001'),
  'review resolution closes the flag while retaining append-only resolution history'
);
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
set local role authenticated;
select throws_ok($$ insert into public.audit_events (area, action, after_value) values ('test', 'insert', '{}'::jsonb) $$, '42501', null, 'authenticated users cannot write append-only audit events directly');
select is((select count(*)::integer from public.audit_events), 0, 'a Viewer cannot read audit events through RLS');
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select throws_ok($$
  insert into public.report_jobs (report_type, period_start, period_end, status, safe_error_summary)
  values ('monthly', '2027-01-01', '2027-01-31', 'failed', null)
$$, '23514', null, 'a failed report job must retain a safe failure summary and timestamp');

select * from finish();

rollback;
