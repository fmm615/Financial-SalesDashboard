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
background_pids=()
admin_id="11111111-1111-4111-8111-111111111111"

run_psql() {
  docker exec "$db_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

cleanup_fixture() {
  run_psql -qAtc "
    begin;
    delete from public.review_flag_resolutions
    where flag_id in (
      select id from public.review_flags
      where source_record_id in (
        'c1100000-0000-4000-8000-000000000001'::uuid,
        'c1100000-0000-4000-8000-000000000002'::uuid,
        'c1200000-0000-4000-8000-000000000001'::uuid,
        'c1200000-0000-4000-8000-000000000002'::uuid,
        'c1200000-0000-4000-8000-000000000003'::uuid,
        'c1300000-0000-4000-8000-000000000001'::uuid,
        'c1300000-0000-4000-8000-000000000002'::uuid
      )
    );
    delete from public.review_flags
    where source_record_id in (
      'c1100000-0000-4000-8000-000000000001'::uuid,
      'c1100000-0000-4000-8000-000000000002'::uuid,
      'c1200000-0000-4000-8000-000000000001'::uuid,
      'c1200000-0000-4000-8000-000000000002'::uuid,
      'c1200000-0000-4000-8000-000000000003'::uuid,
      'c1300000-0000-4000-8000-000000000001'::uuid,
      'c1300000-0000-4000-8000-000000000002'::uuid
    );
    create temporary table concurrency_groups on commit drop as
      select distinct group_id
      from public.b2c_payment_duplicate_group_members
      where payment_id in (
        'c1100000-0000-4000-8000-000000000001'::uuid,
        'c1100000-0000-4000-8000-000000000002'::uuid,
        'c1200000-0000-4000-8000-000000000001'::uuid,
        'c1200000-0000-4000-8000-000000000002'::uuid,
        'c1200000-0000-4000-8000-000000000003'::uuid,
        'c1300000-0000-4000-8000-000000000001'::uuid,
        'c1300000-0000-4000-8000-000000000002'::uuid
      );
    delete from public.b2c_payment_duplicate_group_members
    where group_id in (select group_id from concurrency_groups);
    delete from public.b2c_payment_duplicate_groups
    where id in (select group_id from concurrency_groups);
    delete from public.b2c_payment_local_overrides
    where payment_id in (
      'c1100000-0000-4000-8000-000000000001'::uuid,
      'c1100000-0000-4000-8000-000000000002'::uuid,
      'c1200000-0000-4000-8000-000000000001'::uuid,
      'c1200000-0000-4000-8000-000000000002'::uuid,
      'c1200000-0000-4000-8000-000000000003'::uuid,
      'c1300000-0000-4000-8000-000000000001'::uuid,
      'c1300000-0000-4000-8000-000000000002'::uuid
    );
    delete from public.b2c_payments
    where id in (
      'c1100000-0000-4000-8000-000000000001'::uuid,
      'c1100000-0000-4000-8000-000000000002'::uuid,
      'c1200000-0000-4000-8000-000000000001'::uuid,
      'c1200000-0000-4000-8000-000000000002'::uuid,
      'c1200000-0000-4000-8000-000000000003'::uuid,
      'c1300000-0000-4000-8000-000000000001'::uuid,
        'c1300000-0000-4000-8000-000000000002'::uuid
      );
    commit;
  " >/dev/null 2>&1 || true
}

cleanup() {
  for pid in "${background_pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  cleanup_fixture
  if [[ "$test_tmp_dir" == /tmp/* || "$test_tmp_dir" == /private/tmp/* || "$test_tmp_dir" == /var/folders/* || "$test_tmp_dir" == /private/var/folders/* ]]; then
    rm -rf -- "$test_tmp_dir"
  fi
}
trap cleanup EXIT

start_coordinator() {
  local scenario="$1"
  run_psql -qAtc "
    set application_name = 'b2c_lock_coordinator_$scenario';
    begin;
    select pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));
    select pg_sleep(30);
    commit;
  " >"$test_tmp_dir/coordinator-$scenario.out" 2>&1 &
  coordinator_pid=$!
  background_pids+=("$coordinator_pid")

  local ready=0
  for _attempt in $(seq 1 100); do
    ready="$(run_psql -qAtc "
      select count(*) from pg_stat_activity
      where application_name = 'b2c_lock_coordinator_$scenario'
        and wait_event = 'PgSleep';
    ")"
    [[ "$ready" == "1" ]] && return 0
    sleep 0.1
  done
  echo "The $scenario advisory-lock coordinator did not become ready." >&2
  return 1
}

wait_for_advisory_sessions() {
  local application_names="$1"
  local expected="$2"
  local waiting=0
  for _attempt in $(seq 1 100); do
    waiting="$(run_psql -qAtc "
      select count(*) from pg_stat_activity
      where application_name in ($application_names)
        and wait_event_type = 'Lock'
        and wait_event = 'advisory';
    ")"
    [[ "$waiting" == "$expected" ]] && return 0
    sleep 0.1
  done
  echo "Expected $expected constructor sessions at the advisory lock; observed $waiting." >&2
  return 1
}

release_coordinator() {
  local scenario="$1"
  run_psql -qAtc "
    select pg_terminate_backend(pid) from pg_stat_activity
    where application_name = 'b2c_lock_coordinator_$scenario';
  " >/dev/null
  wait "$coordinator_pid" >/dev/null 2>&1 || true
  coordinator_pid=""
}

wait_for_session() {
  local pid="$1"
  local output_file="$2"
  local label="$3"
  local status=0
  wait "$pid" || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "$label failed:" >&2
    sed 's/^/  /' "$output_file" >&2
    return 1
  fi
}

payment_values_sql() {
  local id="$1"
  local provider_id="$2"
  local email="$3"
  local amount="$4"
  local occurred_at="$5"
  local occurred_on="$6"
  printf "('%s', 'stripe', '%s', '%s', 'membership', 'succeeded', %s, 'USD', 1, %s, %s, '%s', '%s', repeat('1', 64))" \
    "$id" "$provider_id" "$email" "$amount" "$amount" "$amount" "$occurred_at" "$occurred_on"
}

run_trigger_update_race() {
  local scenario="trigger"
  local first_id="c1100000-0000-4000-8000-000000000001"
  local second_id="c1100000-0000-4000-8000-000000000002"
  local first_value second_value
  first_value="$(payment_values_sql "$first_id" 'ch_lock_trigger_1' 'lock.trigger@playbook.test' 55 '2026-09-02 08:00:00+00' '2026-09-02')"
  second_value="$(payment_values_sql "$second_id" 'ch_lock_trigger_2' 'lock.trigger@playbook.test' 55 '2026-09-02 09:00:00+00' '2026-09-02')"
  run_psql -qAtc "
    begin;
    insert into public.b2c_payments (
      id, source_system, provider_transaction_id, customer_email, category_code,
      payment_status, original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint
    ) values $first_value, $second_value;
    delete from public.review_flags where source_record_id in ('$first_id'::uuid, '$second_id'::uuid);
    create temporary table trigger_groups on commit drop as
      select distinct group_id from public.b2c_payment_duplicate_group_members
      where payment_id in ('$first_id'::uuid, '$second_id'::uuid);
    delete from public.b2c_payment_duplicate_group_members where group_id in (select group_id from trigger_groups);
    delete from public.b2c_payment_duplicate_groups where id in (select group_id from trigger_groups);
    commit;
  " >/dev/null
  start_coordinator "$scenario"

  local session_a_pid=""
  local session_b_pid=""
  for session in payment override; do
    if [[ "$session" == "payment" ]]; then
      run_psql -qAtc "
      set application_name = 'b2c_trigger_payment';
      set deadlock_timeout = '100ms';
      set lock_timeout = '5s';
      update public.b2c_payments set customer_email = customer_email where id = '$first_id';
      " >"$test_tmp_dir/trigger-$session.out" 2>&1 &
    else
      run_psql -qAtc "
      set application_name = 'b2c_trigger_override';
      set deadlock_timeout = '100ms';
      set lock_timeout = '5s';
      insert into public.b2c_payment_local_overrides (
        payment_id, customer_email, created_by, updated_by
      ) values ('$second_id', 'lock.trigger@playbook.test', '$admin_id', '$admin_id');
      " >"$test_tmp_dir/trigger-$session.out" 2>&1 &
    fi
    local session_pid=$!
    background_pids+=("$session_pid")
    if [[ "$session" == "payment" ]]; then
      session_a_pid="$session_pid"
    else
      session_b_pid="$session_pid"
    fi
  done
  wait_for_advisory_sessions "'b2c_trigger_payment','b2c_trigger_override'" 2
  release_coordinator "$scenario"
  wait_for_session "$session_a_pid" "$test_tmp_dir/trigger-payment.out" "Payment trigger"
  wait_for_session "$session_b_pid" "$test_tmp_dir/trigger-override.out" "Override trigger"

  local counts
  counts="$(run_psql -qAtc "
    select count(distinct duplicate_group.id) || ':' || count(member.id)
    from public.b2c_payment_duplicate_groups duplicate_group
    join public.b2c_payment_duplicate_group_members member on member.group_id = duplicate_group.id
    where duplicate_group.status = 'open'
      and member.payment_id in ('$first_id'::uuid, '$second_id'::uuid);
  ")"
  [[ "$counts" == "1:2" ]] || { echo "Trigger race did not converge: $counts" >&2; return 1; }
  echo "PASS: actual payment and override write triggers converged without deadlock."
}

run_resolver_race() {
  local scenario="resolver"
  local first_id="c1200000-0000-4000-8000-000000000001"
  local second_id="c1200000-0000-4000-8000-000000000002"
  local third_id="c1200000-0000-4000-8000-000000000003"
  local first_value second_value third_value group_id
  first_value="$(payment_values_sql "$first_id" 'ch_lock_resolver_1' 'lock.resolver@playbook.test' 66 '2026-09-03 08:00:00+00' '2026-09-03')"
  second_value="$(payment_values_sql "$second_id" 'ch_lock_resolver_2' 'lock.resolver@playbook.test' 66 '2026-09-03 09:00:00+00' '2026-09-03')"
  third_value="$(payment_values_sql "$third_id" 'ch_lock_resolver_3' 'other.resolver@playbook.test' 66 '2026-09-03 10:00:00+00' '2026-09-03')"
  run_psql -qAtc "
    insert into public.b2c_payments (
      id, source_system, provider_transaction_id, customer_email, category_code,
      payment_status, original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint
    ) values $first_value, $second_value, $third_value;
  " >/dev/null
  group_id="$(run_psql -qAtc "select group_id from public.b2c_payment_duplicate_group_members where payment_id = '$first_id';")"
  start_coordinator "$scenario"

  run_psql -qAtc "
    set application_name = 'b2c_resolver_trigger';
    set deadlock_timeout = '100ms';
    set lock_timeout = '5s';
    update public.b2c_payments set customer_email = 'lock.resolver@playbook.test' where id = '$third_id';
  " >"$test_tmp_dir/resolver-trigger.out" 2>&1 &
  local trigger_pid=$!
  background_pids+=("$trigger_pid")
  wait_for_advisory_sessions "'b2c_resolver_trigger'" 1

  run_psql -qAtc "
    set application_name = 'b2c_resolver_action';
    set deadlock_timeout = '100ms';
    set lock_timeout = '5s';
    select set_config('request.jwt.claim.sub', '$admin_id', false);
    select public.resolve_b2c_payment_duplicate_group(
      '$group_id', 'keep_all', null, 'Concurrent resolver lock-order regression.'
    );
  " >"$test_tmp_dir/resolver-action.out" 2>&1 &
  local resolver_pid=$!
  background_pids+=("$resolver_pid")
  wait_for_advisory_sessions "'b2c_resolver_trigger','b2c_resolver_action'" 2
  release_coordinator "$scenario"
  wait_for_session "$trigger_pid" "$test_tmp_dir/resolver-trigger.out" "Resolver-race trigger"
  wait_for_session "$resolver_pid" "$test_tmp_dir/resolver-action.out" "Resolver action"

  local counts
  counts="$(run_psql -qAtc "
    select status || ':' || (
      select count(*) from public.b2c_payment_duplicate_group_members member
      where member.group_id = duplicate_group.id and member.decision = 'include'
    ) from public.b2c_payment_duplicate_groups duplicate_group where id = '$group_id';
  ")"
  [[ "$counts" == "resolved:3" ]] || { echo "Resolver race left an invalid case: $counts" >&2; return 1; }
  echo "PASS: trigger-driven extension and Admin resolution serialized without deadlock."
}

run_stale_dismissal_race() {
  local scenario="stale"
  local first_id="c1300000-0000-4000-8000-000000000001"
  local second_id="c1300000-0000-4000-8000-000000000002"
  local flag_id="d1300000-0000-4000-8000-000000000001"
  local first_value second_value
  first_value="$(payment_values_sql "$first_id" 'ch_lock_stale_1' 'lock.stale@playbook.test' 77 '2026-09-04 08:00:00+00' '2026-09-04')"
  second_value="$(payment_values_sql "$second_id" 'ch_lock_stale_2' 'lock.stale@playbook.test' 77 '2026-09-04 09:00:00+00' '2026-09-04')"
  run_psql -qAtc "
    begin;
    insert into public.b2c_payments (
      id, source_system, provider_transaction_id, customer_email, category_code,
      payment_status, original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on, duplicate_fingerprint
    ) values $first_value, $second_value;
    delete from public.review_flags where source_record_id in ('$first_id'::uuid, '$second_id'::uuid);
    create temporary table stale_groups on commit drop as
      select distinct group_id from public.b2c_payment_duplicate_group_members
      where payment_id in ('$first_id'::uuid, '$second_id'::uuid);
    delete from public.b2c_payment_duplicate_group_members where group_id in (select group_id from stale_groups);
    delete from public.b2c_payment_duplicate_groups where id in (select group_id from stale_groups);
    insert into public.review_flags (id, source_area, source_record_id, flag_type, priority, reason)
    values ('$flag_id', 'b2c_payment', '$first_id', 'possible_duplicate', 2,
      'Historical possible duplicate awaiting stale-evidence validation.');
    commit;
  " >/dev/null
  start_coordinator "$scenario"

  run_psql -qAtc "
    set application_name = 'b2c_stale_trigger';
    set deadlock_timeout = '100ms';
    set lock_timeout = '5s';
    update public.b2c_payments set customer_email = customer_email where id = '$second_id';
  " >"$test_tmp_dir/stale-trigger.out" 2>&1 &
  local trigger_pid=$!
  background_pids+=("$trigger_pid")
  wait_for_advisory_sessions "'b2c_stale_trigger'" 1

  run_psql -qAtc "
    set application_name = 'b2c_stale_action';
    set deadlock_timeout = '100ms';
    set lock_timeout = '5s';
    select set_config('request.jwt.claim.sub', '$admin_id', false);
    do \$\$
    begin
      perform public.dismiss_stale_b2c_possible_duplicate_flag(
        '$flag_id', 'Concurrent stale-dismissal lock-order regression.'
      );
      raise exception 'Expected current duplicate evidence to reject dismissal';
    exception when others then
      if sqlerrm <> 'This possible duplicate still has a current duplicate group' then
        raise;
      end if;
    end;
    \$\$;
  " >"$test_tmp_dir/stale-action.out" 2>&1 &
  local stale_pid=$!
  background_pids+=("$stale_pid")
  wait_for_advisory_sessions "'b2c_stale_trigger','b2c_stale_action'" 2
  release_coordinator "$scenario"
  wait_for_session "$trigger_pid" "$test_tmp_dir/stale-trigger.out" "Stale-race trigger"
  wait_for_session "$stale_pid" "$test_tmp_dir/stale-action.out" "Stale dismissal"

  local state
  state="$(run_psql -qAtc "
    select flag.status || ':' || count(distinct duplicate_group.id)
    from public.review_flags flag
    left join public.b2c_payment_duplicate_group_members member on member.payment_id = flag.source_record_id
    left join public.b2c_payment_duplicate_groups duplicate_group
      on duplicate_group.id = member.group_id and duplicate_group.status = 'open'
    where flag.id = '$flag_id'
    group by flag.status;
  ")"
  [[ "$state" == "open:1" ]] || { echo "Stale race did not fail closed: $state" >&2; return 1; }
  echo "PASS: trigger construction and stale dismissal serialized and retained current evidence."
}

cleanup_fixture
case "${1:-all}" in
  trigger) run_trigger_update_race ;;
  resolver) run_resolver_race ;;
  stale) run_stale_dismissal_race ;;
  all)
    run_trigger_update_race
    run_resolver_race
    run_stale_dismissal_race
    ;;
  *) echo "Usage: $0 [trigger|resolver|stale|all]" >&2; exit 2 ;;
esac
