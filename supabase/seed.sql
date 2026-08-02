-- DEVELOPMENT ONLY. All addresses use .test and all UUIDs are non-production data.
-- This seed is never deployed as a production migration.

insert into public.approved_users (email, display_name, default_role_id)
select seed.email::citext, seed.display_name, roles.id
from (
  values
    ('fatema.hasan@playbook.test', 'Fatema Hasan', 'admin'),
    ('walaa@playbook.test', 'Walaa', 'admin'),
    ('mohammed@playbook.test', 'Mohammed', 'admin'),
    ('wafa@playbook.test', 'Wafa', 'viewer'),
    ('shreya@playbook.test', 'Shreya', 'viewer')
) as seed(email, display_name, role_code)
join public.roles on roles.code = seed.role_code::public.access_role
on conflict (email) do nothing;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fatema.hasan@playbook.test', 'not-a-login', timezone('utc', now()), '{"provider":"google","providers":["google"]}', '{"full_name":"Fatema Hasan"}', timezone('utc', now()), timezone('utc', now())),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'walaa@playbook.test', 'not-a-login', timezone('utc', now()), '{"provider":"google","providers":["google"]}', '{"full_name":"Walaa"}', timezone('utc', now()), timezone('utc', now())),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mohammed@playbook.test', 'not-a-login', timezone('utc', now()), '{"provider":"google","providers":["google"]}', '{"full_name":"Mohammed"}', timezone('utc', now()), timezone('utc', now())),
  ('44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wafa@playbook.test', 'not-a-login', timezone('utc', now()), '{"provider":"google","providers":["google"]}', '{"full_name":"Wafa"}', timezone('utc', now()), timezone('utc', now())),
  ('55555555-5555-4555-8555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'shreya@playbook.test', 'not-a-login', timezone('utc', now()), '{"provider":"google","providers":["google"]}', '{"full_name":"Shreya"}', timezone('utc', now()), timezone('utc', now()))
on conflict do nothing;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

insert into public.products (id, internal_code, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'membership_monthly', 'PLAYBOOK Monthly Membership'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'membership_annual', 'PLAYBOOK Annual Membership')
on conflict do nothing;

insert into public.product_mappings (
  id, source_system, external_product_id, product_id, category_code, membership_tier, created_by, updated_by
) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'stripe', 'price_monthly_test', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'membership', 'monthly', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'tap', 'tap_annual_test', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'membership', 'annual', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.customers (id, email, full_name) values
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'member.one@playbook.test', 'Member One'),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'member.two@playbook.test', 'Member Two')
on conflict do nothing;

insert into public.b2c_payments (
  id, source_system, provider_transaction_id, provider_event_id, customer_id, customer_email,
  product_mapping_id, category_code, membership_tier, payment_status, original_amount,
  original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, tax_amount_usd,
  net_amount_usd, occurred_at, occurred_on, duplicate_fingerprint, reconciliation_source
) values
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'stripe', 'pi_test_001', 'evt_test_001', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'member.one@playbook.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'membership', 'monthly', 'succeeded', 100.000000, 'USD', 1.0000000000, 100.000000, 100.000000, 0.000000, 100.000000, '2026-08-01 08:00:00+00', '2026-08-01', repeat('a', 64), 'seed'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'tap', 'tap_test_002', 'evt_test_002', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'member.two@playbook.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'membership', 'annual', 'failed', 50.000000, 'USD', 1.0000000000, 50.000000, 50.000000, 0.000000, 50.000000, '2026-08-02 08:00:00+00', '2026-08-02', repeat('b', 64), 'seed')
on conflict do nothing;

insert into public.b2c_refunds (
  id, payment_id, source_system, provider_refund_id, original_amount, original_currency,
  exchange_rate_to_usd, amount_usd, reason, occurred_at
) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'stripe', 're_test_001', 25.000000, 'USD', 1.0000000000, 25.000000, 'Partial member refund (fake)', '2026-08-02 09:00:00+00')
on conflict do nothing;

insert into public.b2b_companies (id, source_system, external_company_id, legal_name) values
  ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'hubspot', 'hs_company_001', 'AI Noor Group (fake)')
on conflict do nothing;

insert into public.b2b_deals (
  id, company_id, source_system, external_deal_id, name, stage_code, pipeline_original_amount,
  original_currency, exchange_rate_to_usd, pipeline_amount_usd, hubspot_close_date, renewal_date, owner_name
) values
  ('12121212-1212-4212-8212-121212121212', 'ffffffff-ffff-4fff-8fff-fffffffffff1', 'hubspot', 'hs_deal_001', 'AI Noor Group Annual Agreement (fake)', 'closed_won', 120000.000000, 'USD', 1.0000000000, 120000.000000, '2026-08-01', '2027-08-01', 'Shreya')
on conflict do nothing;

insert into public.b2b_bookings (
  id, deal_id, source_system, booking_date, original_amount, original_currency,
  exchange_rate_to_usd, booking_amount_usd, source_reference
) values
  ('13131313-1313-4313-8313-131313131313', '12121212-1212-4212-8212-121212121212', 'hubspot', '2026-08-01', 120000.000000, 'USD', 1.0000000000, 120000.000000, 'HubSpot close date')
on conflict do nothing;

-- This is a manual entry. It is intentionally separate from the $120,000 booking.
insert into public.b2b_recognised_sales (
  id, deal_id, booking_id, recognised_amount, original_currency, exchange_rate_to_usd,
  recognised_amount_usd, recognition_date, reporting_period, reason_or_reference, entered_by
) values
  ('14141414-1414-4414-8414-141414141414', '12121212-1212-4212-8212-121212121212', '13131313-1313-4313-8313-131313131313', 10000.000000, 'USD', 1.0000000000, 10000.000000, '2026-08-31', '2026-08-01', 'August recognition approved for fake seed deal', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.financial_targets (id, metric_code, period_start, period_end, target_amount_usd, notes, created_by, updated_by)
values ('15151515-1515-4515-8515-151515151515', 'sales', '2026-08-01', '2026-08-31', 200000.000000, 'Fake development target', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.summit_targets (id, metric_code, period_start, period_end, target_value, value_currency, created_by, updated_by)
values ('16161616-1616-4616-8616-161616161616', 'tickets', '2026-01-01', '2026-12-31', 500.000000, null, '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.data_coverage (domain_area, source_system, period_start, period_end, coverage_status, source_record_count, notes)
values
  ('b2c', 'stripe', '2024-01-01', '2024-12-31', 'unavailable', null, 'Fake example: historical data not yet backfilled'),
  ('b2c', 'stripe', '2026-08-01', '2026-08-31', 'complete', 0, 'Fake example: loaded period with a known zero count')
on conflict do nothing;

insert into public.review_flags (id, source_area, source_record_id, flag_type, priority, reason, created_by)
values
  ('17171717-1717-4717-8717-171717171717', 'b2c_refund', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'refunded', 2, 'Confirm fake refund reason is recorded', '11111111-1111-4111-8111-111111111111'),
  ('18181818-1818-4818-8818-181818181818', 'b2c_payment', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'failed', 3, 'Follow up on fake failed payment', '11111111-1111-4111-8111-111111111111'),
  ('19191919-1919-4919-8919-191919191919', 'b2c_payment', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'possible_duplicate', 1, 'Fake fingerprint match requires a decision', '11111111-1111-4111-8111-111111111111'),
  ('20202020-2020-4020-8020-202020202020', 'product_mapping', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'unmapped_product', 4, 'Fake unmapped product workflow example', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note, created_by)
values ('17171717-1717-4717-8717-171717171717', 'resolved', 'Fake refund reason checked and retained.', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.financial_corrections (
  id, target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on, created_by
) values (
  '23232323-2323-4232-8232-232323232323', 'b2c_payment', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'category',
  '{"category_code":"unmapped"}', '{"category_code":"membership"}',
  'Fake append-only correction for development', '2026-08-02', '11111111-1111-4111-8111-111111111111'
)
on conflict do nothing;

insert into public.report_jobs (
  id, report_type, period_start, period_end, status, requested_by, requested_at, failed_at, safe_error_summary
) values
  ('21212121-2121-4212-8212-212121212121', 'monthly', '2026-07-01', '2026-07-31', 'failed', '11111111-1111-4111-8111-111111111111', timezone('utc', now()), timezone('utc', now()), 'Fake development failure: no files were generated'),
  ('22222222-2222-4222-8222-222222222223', 'ad_hoc', '2026-08-01', '2026-08-02', 'pending', '11111111-1111-4111-8111-111111111111', timezone('utc', now()), null, null)
on conflict do nothing;
