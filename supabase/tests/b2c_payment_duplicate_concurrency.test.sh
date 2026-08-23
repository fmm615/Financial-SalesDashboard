#!/usr/bin/env bash
set -euo pipefail

db_container="${SUPABASE_DB_CONTAINER:-}"
if [[ -z "$db_container" ]]; then
  db_container="$(docker ps --format '{{.Names}}' | awk '/^supabase_db_/ { print; exit }')"
fi

if [[ -z "$db_container" ]]; then
  echo "No running local Supabase PostgreSQL container was found." >&2
  exit 2
fi

test_tmp_dir="$(mktemp -d)"
coordinator_pid=""

run_psql() {
  docker exec "$db_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

cleanup_fixture() {
  run_psql -qAtc "
    delete from public.review_flag_resolutions
    where flag_id in (
      select id from public.review_flags
      where source_area = 'b2c_payment'
        and source_record_id in (
          'c1000000-0000-4000-8000-000000000001'::uuid,
          'c1000000-0000-4000-8000-000000000002'::uuid
        )
    );
    delete from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id in (
        'c1000000-0000-4000-8000-000000000001'::uuid,
        'c1000000-0000-4000-8000-000000000002'::uuid
      );
    delete from public.b2c_payment_duplicate_group_members
    where payment_id in (
      'c1000000-0000-4000-8000-000000000001'::uuid,
      'c1000000-0000-4000-8000-000000000002'::uuid
    );
    delete from public.b2c_payment_duplicate_groups duplicate_group
    where duplicate_group.fingerprint = encode(extensions.digest(
      'concurrency.lock@playbook.test|USD|77.000000|membership|2026-09-01',
      'sha256'
    ), 'hex')
      and not exists (
        select 1 from public.b2c_payment_duplicate_group_members member
        where member.group_id = duplicate_group.id
      );
    delete from public.b2c_payments
    where id in (
      'c1000000-0000-4000-8000-000000000001'::uuid,
      'c1000000-0000-4000-8000-000000000002'::uuid
    );
  " >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "$coordinator_pid" ]]; then
    kill "$coordinator_pid" >/dev/null 2>&1 || true
    wait "$coordinator_pid" >/dev/null 2>&1 || true
  fi
  cleanup_fixture
  if [[ "$test_tmp_dir" == /tmp/* || "$test_tmp_dir" == /private/tmp/* || "$test_tmp_dir" == /var/folders/* || "$test_tmp_dir" == /private/var/folders/* ]]; then
    rm -rf -- "$test_tmp_dir"
  fi
}
trap cleanup EXIT

cleanup_fixture

run_psql -qAtc "
  begin;
  alter table public.b2c_payments
    disable trigger open_b2c_payment_duplicate_group_after_payment_write;
  insert into public.b2c_payments (
    id, source_system, provider_transaction_id, customer_email, category_code,
    payment_status, original_amount, original_currency, exchange_rate_to_usd,
    amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint
  ) values
    (
      'c1000000-0000-4000-8000-000000000001', 'stripe', 'ch_concurrency_lock_1',
      'concurrency.lock@playbook.test', 'membership', 'succeeded', 77, 'USD', 1,
      77, 77, '2026-09-01 08:00:00+00', '2026-09-01', repeat('1', 64)
    ),
    (
      'c1000000-0000-4000-8000-000000000002', 'tap', 'tap_concurrency_lock_2',
      'concurrency.lock@playbook.test', 'membership', 'succeeded', 77, 'USD', 1,
      77, 77, '2026-09-01 09:00:00+00', '2026-09-01', repeat('2', 64)
    );
  alter table public.b2c_payments
    enable trigger open_b2c_payment_duplicate_group_after_payment_write;
  commit;
" >/dev/null

fingerprint="$(run_psql -qAtc "
  select fingerprint
  from public.get_effective_b2c_duplicate_facts(
    'c1000000-0000-4000-8000-000000000001'
  );
")"

if [[ ! "$fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
  echo "The concurrency fixture did not produce a valid fingerprint." >&2
  exit 1
fi

run_psql -qAtc "
  set application_name = 'b2c_duplicate_lock_coordinator';
  begin;
  select pg_advisory_xact_lock(hashtext('b2c_payment_duplicate:$fingerprint'));
  select pg_sleep(30);
  commit;
" >"$test_tmp_dir/coordinator.out" 2>&1 &
coordinator_pid=$!

coordinator_ready=0
for _attempt in $(seq 1 100); do
  coordinator_ready="$(run_psql -qAtc "
    select count(*)
    from pg_stat_activity
    where application_name = 'b2c_duplicate_lock_coordinator'
      and wait_event = 'PgSleep';
  ")"
  if [[ "$coordinator_ready" == "1" ]]; then
    break
  fi
  sleep 0.1
done

if [[ "$coordinator_ready" != "1" ]]; then
  echo "The advisory-lock coordinator did not become ready." >&2
  exit 1
fi

run_psql -qAtc "
  set application_name = 'b2c_duplicate_constructor_a';
  set deadlock_timeout = '100ms';
  set lock_timeout = '5s';
  select public.open_b2c_payment_duplicate_group(
    'c1000000-0000-4000-8000-000000000001'
  );
" >"$test_tmp_dir/session-a.out" 2>&1 &
session_a_pid=$!

run_psql -qAtc "
  set application_name = 'b2c_duplicate_constructor_b';
  set deadlock_timeout = '100ms';
  set lock_timeout = '5s';
  select public.open_b2c_payment_duplicate_group(
    'c1000000-0000-4000-8000-000000000002'
  );
" >"$test_tmp_dir/session-b.out" 2>&1 &
session_b_pid=$!

waiting_sessions=0
for _attempt in $(seq 1 100); do
  waiting_sessions="$(run_psql -qAtc "
    select count(*)
    from pg_stat_activity
    where application_name in (
      'b2c_duplicate_constructor_a',
      'b2c_duplicate_constructor_b'
    )
      and wait_event_type = 'Lock'
      and wait_event = 'advisory';
  ")"
  if [[ "$waiting_sessions" == "2" ]]; then
    break
  fi
  sleep 0.1
done

if [[ "$waiting_sessions" != "2" ]]; then
  echo "Both constructor sessions did not reach the shared advisory lock." >&2
  exit 1
fi

run_psql -qAtc "
  select pg_terminate_backend(pid)
  from pg_stat_activity
  where application_name = 'b2c_duplicate_lock_coordinator';
" >/dev/null
wait "$coordinator_pid" >/dev/null 2>&1 || true
coordinator_pid=""

session_a_status=0
session_b_status=0
wait "$session_a_pid" || session_a_status=$?
wait "$session_b_pid" || session_b_status=$?

if [[ "$session_a_status" -ne 0 || "$session_b_status" -ne 0 ]]; then
  echo "Concurrent constructor calls did not both complete." >&2
  echo "Session A:" >&2
  sed 's/^/  /' "$test_tmp_dir/session-a.out" >&2
  echo "Session B:" >&2
  sed 's/^/  /' "$test_tmp_dir/session-b.out" >&2
  exit 1
fi

group_count="$(run_psql -qAtc "
  select count(*)
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = '$fingerprint'
    and duplicate_group.status = 'open';
")"
member_count="$(run_psql -qAtc "
  select count(*)
  from public.b2c_payment_duplicate_group_members member
  where member.payment_id in (
    'c1000000-0000-4000-8000-000000000001'::uuid,
    'c1000000-0000-4000-8000-000000000002'::uuid
  );
")"

if [[ "$group_count" != "1" || "$member_count" != "2" ]]; then
  echo "Concurrent construction did not converge on one two-member group." >&2
  echo "group_count=$group_count member_count=$member_count" >&2
  exit 1
fi

echo "PASS: concurrent constructor calls completed without deadlock and converged on one two-member group."
