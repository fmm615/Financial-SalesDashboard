begin;

select plan(16);

-- Seeded Fatema is an Admin; seeded Wafa is a Viewer (see database_foundation.test.sql).
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- 1-3: the settings table exists, is a real singleton, and defaults to the
-- documented historical 48-hour window.
select has_table('public', 'b2c_settings', 'the B2C settings table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.b2c_settings'::regclass),
  'b2c_settings has row level security enabled'
);
select is(
  (select duplicate_detection_window_hours from public.b2c_settings where id = true),
  48,
  'the duplicate-detection window defaults to 48 hours'
);

-- 4: a second row is impossible (id is a boolean primary key checked true).
select throws_ok($$
  insert into public.b2c_settings (id, duplicate_detection_window_hours) values (false, 48)
$$, '23514', null, 'a second b2c_settings row is rejected by the singleton check');

-- 5-7: a Viewer cannot change the window through the RPC, and RLS
-- independently blocks a direct table UPDATE (silently excludes the row
-- rather than erroring, since the admin_update policy's USING clause governs
-- which rows an UPDATE can even target).
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
set local role authenticated;
select throws_ok($$
  select public.update_b2c_duplicate_detection_window(72, 'Viewer attempting to widen the window.')
$$, 'P0001', 'Admin access is required', 'a Viewer cannot change the B2C duplicate-detection window through the RPC');
select lives_ok($$
  update public.b2c_settings set duplicate_detection_window_hours = 72 where id = true
$$, 'a Viewer direct UPDATE statement runs without error (RLS silently excludes the row)');
reset role;
select is(
  (select duplicate_detection_window_hours from public.b2c_settings where id = true),
  48,
  'RLS independently prevented the Viewer direct UPDATE from taking effect; the window is unchanged'
);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

-- 8-10: bounds validation. 0 and 169 are rejected; a missing/short reason is rejected.
select throws_ok($$
  select public.update_b2c_duplicate_detection_window(0, 'Too small a window.')
$$, 'P0001', 'The duplicate-detection window must be between 1 and 168 hours', 'zero hours is rejected');
select throws_ok($$
  select public.update_b2c_duplicate_detection_window(169, 'Too large a window.')
$$, 'P0001', 'The duplicate-detection window must be between 1 and 168 hours', 'more than 168 hours (7 days) is rejected');
select throws_ok($$
  select public.update_b2c_duplicate_detection_window(72, 'ok')
$$, 'P0001', 'A reason between 3 and 1000 characters is required', 'a too-short reason is rejected');

-- 11-12: a valid Admin change takes effect and stamps the actor.
select lives_ok($$
  select public.update_b2c_duplicate_detection_window(1, 'Narrowing the window to test tight-window duplicate detection.')
$$, 'an Admin can change the B2C duplicate-detection window within bounds');
select ok(
  (select duplicate_detection_window_hours = 1 and updated_by = '11111111-1111-4111-8111-111111111111'::uuid and reason is not null
   from public.b2c_settings where id = true),
  'the change is persisted with the reason and the Admin actor recorded'
);

-- 13: the change is audited exactly like other admin settings changes.
select ok(
  exists (
    select 1 from public.audit_events
    where area = 'b2c_settings' and action = 'update'
      and actor_profile_id = '11111111-1111-4111-8111-111111111111'::uuid
      and reason = 'Narrowing the window to test tight-window duplicate detection.'
  ),
  'the B2C settings change is recorded in the audit trail with actor and reason'
);

-- 14-16: the ledger's possible-duplicate flagging actually respects the
-- configured window, not a hardcoded 48 hours. Two content-identical succeeded
-- payments land 2 hours apart -- outside a 1-hour window, inside a 48-hour one.
insert into public.b2c_payments (id, source_system, provider_transaction_id, customer_email, payment_status, original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint)
values ('b2000000-0000-4000-8000-000000000001', 'stripe', 'ch_window_setting_1', 'window.setting@playbook.test', 'succeeded', 60, 'USD', 1, 60, 60, '2027-02-01 08:00:00+00', '2027-02-01', repeat('1', 64));
insert into public.b2c_payments (id, source_system, provider_transaction_id, customer_email, payment_status, original_amount, original_currency, exchange_rate_to_usd, amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint)
values ('b2000000-0000-4000-8000-000000000002', 'stripe', 'ch_window_setting_2', 'window.setting@playbook.test', 'succeeded', 60, 'USD', 1, 60, 60, '2027-02-01 10:00:00+00', '2027-02-01', repeat('2', 64));

select ok(
  not exists (
    select 1 from public.b2c_payment_duplicate_group_members member
    where member.payment_id in ('b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002')
  ),
  'with a 1-hour configured window, payments 2 hours apart are not flagged as possible duplicates'
);

select lives_ok($$
  select public.update_b2c_duplicate_detection_window(48, 'Restoring the default window after the tight-window check.')
$$, 'the window can be widened back toward the default');
select public.open_b2c_payment_duplicate_group('b2000000-0000-4000-8000-000000000002');
select ok(
  exists (
    select 1 from public.b2c_payment_duplicate_group_members member
    where member.payment_id in ('b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002')
  ),
  'after widening to 48 hours, the same two payments are now flagged as possible duplicates'
);

select * from finish();
rollback;
