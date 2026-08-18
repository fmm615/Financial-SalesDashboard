

-- A displayed effective balance is an optimistic-concurrency token. The source
-- payment and prior append-only entries remain immutable; stale browser tabs
-- must reload instead of applying a correction against an old balance.

create or replace function public.apply_b2c_finance_posted_adjustment_with_expected_state(
  p_finance_row_id uuid,
  p_occurred_on date,
  p_amount_usd numeric,
  p_customer_name text,
  p_category_raw text,
  p_adjustment_request_id uuid,
  p_reason text,
  p_expected_amount_usd numeric,
  p_expected_occurred_on date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_post public.b2c_finance_ledger_posts%rowtype;
  target_payment public.b2c_payments%rowtype;
  current_occurred_on date;
  current_amount_usd numeric(20, 6);
  effective_balance_count integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can adjust a posted B2C Finance payment';
  end if;
  if p_adjustment_request_id is null or p_expected_amount_usd is null or p_expected_occurred_on is null then
    raise exception 'Reload this B2C Finance payment before saving an adjustment';
  end if;

  select posts.* into target_post from public.b2c_finance_ledger_posts posts
  where posts.finance_row_id = p_finance_row_id for update;
  if not found then raise exception 'The posted B2C Finance payment is unavailable'; end if;
  select payments.* into target_payment from public.b2c_payments payments
  where payments.id = target_post.payment_id for update;
  if not found then raise exception 'The posted B2C Finance payment is unavailable'; end if;

  -- Idempotent retries always converge, even if a successful first attempt has
  -- already changed the effective balance.
  if exists (select 1 from public.b2c_finance_ledger_adjustments adjustments
    where adjustments.payment_id = target_post.payment_id and adjustments.adjustment_request_id = p_adjustment_request_id) then
    return 0;
  end if;

  with ledger_entries as (
    select target_payment.occurred_on as business_date, target_payment.amount_usd::numeric as signed_amount_usd
    union all
    select adjustments.occurred_on, adjustments.amount_delta_usd::numeric
    from public.b2c_finance_ledger_adjustments adjustments
    where adjustments.payment_id = target_post.payment_id and adjustments.finance_row_id = target_post.finance_row_id
  ), effective_balances as (
    select business_date, sum(signed_amount_usd)::numeric(20, 6) as amount_usd
    from ledger_entries group by business_date having sum(signed_amount_usd) <> 0
  )
  select count(*)::integer, min(business_date), min(amount_usd)
  into effective_balance_count, current_occurred_on, current_amount_usd from effective_balances;

  if effective_balance_count <> 1 or current_amount_usd is null or current_occurred_on is null then
    raise exception 'The current posted B2C Finance balance needs review before another adjustment';
  end if;
  if current_amount_usd is distinct from p_expected_amount_usd or current_occurred_on is distinct from p_expected_occurred_on then
    raise exception 'This B2C Finance payment changed after it was opened. Reload it before saving another adjustment';
  end if;

  return public.apply_b2c_finance_posted_adjustment(
    p_finance_row_id, p_occurred_on, p_amount_usd, p_customer_name, p_category_raw,
    p_adjustment_request_id, p_reason
  );
end;
$$;

create or replace function public.get_b2c_finance_posted_adjustments_page(
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  id uuid, payment_id uuid, finance_row_id uuid, adjustment_request_id uuid,
  entry_index smallint, adjustment_kind text, amount_delta_usd numeric,
  occurred_on date, reason text, created_by uuid, created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can view posted B2C Finance adjustments';
  end if;
  if p_limit not between 1 and 1000 or p_offset < 0 then raise exception 'Invalid B2C Finance adjustment page'; end if;
  return query select adjustments.id, adjustments.payment_id, adjustments.finance_row_id,
    adjustments.adjustment_request_id, adjustments.entry_index, adjustments.adjustment_kind,
    adjustments.amount_delta_usd::numeric, adjustments.occurred_on, adjustments.reason,
    adjustments.created_by, adjustments.created_at
  from public.b2c_finance_ledger_adjustments adjustments
  order by adjustments.created_at, adjustments.id
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.apply_b2c_finance_posted_adjustment_with_expected_state(uuid, date, numeric, text, text, uuid, text, numeric, date) from public;
revoke all on function public.get_b2c_finance_posted_adjustments_page(integer, integer) from public;
-- The legacy constructor remains callable only inside the new security-definer
-- wrapper. Browser roles must not be able to bypass expected-state checks.
revoke execute on function public.apply_b2c_finance_posted_adjustment(uuid, date, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_b2c_finance_posted_adjustment_with_expected_state(uuid, date, numeric, text, text, uuid, text, numeric, date) to authenticated;
grant execute on function public.get_b2c_finance_posted_adjustments_page(integer, integer) to authenticated;
