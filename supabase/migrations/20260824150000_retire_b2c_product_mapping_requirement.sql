-- Product mappings remain readable historical evidence, but the retired
-- browser workflow must not leave an authenticated write path behind.
revoke execute on function public.apply_stripe_product_mapping(text, text, text, text, text, text)
  from authenticated;
revoke execute on function public.apply_b2c_product_mapping(text, text, text, text, text, text, text)
  from authenticated;

revoke insert, update on table public.product_mappings from authenticated;
drop policy if exists admin_insert on public.product_mappings;
drop policy if exists admin_update on public.product_mappings;

-- Finance exceptions still retain the effective category in correction history,
-- but an unmapped provider category is no longer a reporting blocker.
create or replace function public.include_b2c_payment_with_finance_exception(
  p_payment_id uuid, p_reason text, p_confirmed_provider_transaction boolean, p_confirmed_no_known_duplicate boolean
)
returns void language plpgsql security definer set search_path = public as $$
declare target_payment public.b2c_payments%rowtype; local_override public.b2c_payment_local_overrides%rowtype; fx_conversion public.b2c_payment_fx_conversions%rowtype; effective_category_code text; effective_amount_usd numeric(20, 6); effective_occurred_on date; prior_decision text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can include a B2C payment by Finance exception'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'A Finance exception reason must be between 3 and 1000 characters'; end if;
  if p_confirmed_provider_transaction is not true or p_confirmed_no_known_duplicate is not true then raise exception 'Confirm the provider transaction and duplicate review before including this payment'; end if;
  select * into target_payment from public.b2c_payments where id = p_payment_id for update;
  if not found then raise exception 'The B2C payment is unavailable'; end if;
  if target_payment.payment_status <> 'succeeded' then raise exception 'Only a succeeded provider payment can be included by Finance exception'; end if;
  if target_payment.provider_transaction_id is null or (select count(*) from public.b2c_payments where provider_transaction_id = target_payment.provider_transaction_id) <> 1 then raise exception 'A Finance exception requires the exact unique provider transaction ID'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'possible_duplicate') then raise exception 'Resolve the possible duplicate before using a Finance exception'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'needs_follow_up' and reason !~* 'missing a valid customer email') then raise exception 'This payment has another unresolved source issue that cannot be bypassed'; end if;
  select * into local_override from public.b2c_payment_local_overrides where payment_id = p_payment_id;
  select * into fx_conversion from public.b2c_payment_fx_conversions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  effective_category_code := coalesce(local_override.category_code, target_payment.category_code);
  -- A foreign source can use only its append-only Finance conversion. This
  -- deliberately ignores any historical generic local USD overlay.
  effective_amount_usd := case
    when target_payment.original_currency <> 'USD' then fx_conversion.amount_usd
    else coalesce(local_override.local_amount_usd, target_payment.amount_usd)
  end;
  effective_occurred_on := coalesce(local_override.local_occurred_on, target_payment.occurred_on);
  if effective_amount_usd is null or effective_amount_usd <= 0 or effective_occurred_on is null then raise exception 'Record a Finance-approved USD conversion and verified business date before using a Finance exception'; end if;
  select decision into prior_decision from public.b2c_payment_finance_exception_decisions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  insert into public.b2c_payment_finance_exception_decisions (payment_id, decision, reason, confirmed_provider_transaction, confirmed_no_known_duplicate, created_by) values (p_payment_id, 'include', trim(p_reason), true, true, auth.uid());
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2c_payment', p_payment_id, 'other', jsonb_build_object('finance_exception_decision', coalesce(prior_decision, 'none')), jsonb_build_object('finance_exception_decision', 'include', 'provider_transaction_id', target_payment.provider_transaction_id, 'category_code', effective_category_code, 'amount_usd', effective_amount_usd, 'occurred_on', effective_occurred_on, 'missing_source_fields_remain_visible', true), trim(p_reason), effective_occurred_on);
end;
$$;

revoke all on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) from public;
grant execute on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) to authenticated;
