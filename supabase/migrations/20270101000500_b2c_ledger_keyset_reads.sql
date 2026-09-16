-- B2C Ledger read-path performance foundation.
-- Additive only: existing domain migrations remain immutable.

create index b2c_payment_local_overrides_occurred_on_idx
  on public.b2c_payment_local_overrides (local_occurred_on desc, payment_id)
  where local_occurred_on is not null;

create index b2c_refunds_occurred_on_idx
  on public.b2c_refunds (((occurred_at at time zone 'UTC')::date) desc, id);

create or replace function public.b2c_payment_decision_reasons(
  p_payment_status text,
  p_customer_email text,
  p_original_currency text,
  p_amount_usd numeric,
  p_has_finance_exception boolean,
  p_is_approved_finance_payment boolean,
  p_has_open_payment_duplicate boolean,
  p_has_duplicate_exclusion boolean,
  p_has_blocking_needs_follow_up boolean,
  p_source_system text,
  p_occurred_on date,
  p_today date
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  exclusion_reasons jsonb := '[]'::jsonb;
  blocking_reasons jsonb := '[]'::jsonb;
  reporting_decision text;
begin
  if p_payment_status not in ('succeeded', 'failed', 'pending') then
    raise exception 'Invalid B2C payment status';
  end if;
  if p_source_system not in ('stripe', 'tap', 'manual_bank_transfer', 'finance_tracker') then
    raise exception 'Invalid B2C source system';
  end if;
  if p_original_currency is null or p_original_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid B2C original currency';
  end if;
  if p_today is null then
    raise exception 'A B2C decision requires today';
  end if;

  if p_occurred_on is null then
    blocking_reasons := blocking_reasons || '"missing_business_date"'::jsonb;
  elsif p_occurred_on > p_today + 1 then
    blocking_reasons := blocking_reasons || '"implausible_future_date"'::jsonb;
  end if;

  if p_amount_usd is null then
    exclusion_reasons := exclusion_reasons || '"needs_fx_review"'::jsonb;
    blocking_reasons := blocking_reasons
      || to_jsonb(case when p_original_currency = 'USD' then 'missing_amount' else 'missing_fx' end);
  end if;

  if p_payment_status <> 'succeeded' then
    exclusion_reasons := exclusion_reasons || '"not_succeeded"'::jsonb;
    blocking_reasons := blocking_reasons
      || to_jsonb(case when p_payment_status = 'failed' then 'failed_payment' else 'pending_payment' end);
  end if;

  if nullif(trim(p_customer_email), '') is null
    and not coalesce(p_has_finance_exception, false)
    and not coalesce(p_is_approved_finance_payment, false)
  then
    exclusion_reasons := exclusion_reasons || '"missing_customer_email"'::jsonb;
    blocking_reasons := blocking_reasons || '"missing_customer_email"'::jsonb;
  end if;

  if coalesce(p_has_open_payment_duplicate, false) then
    exclusion_reasons := exclusion_reasons || '"possible_duplicate"'::jsonb;
    blocking_reasons := blocking_reasons || '"possible_duplicate"'::jsonb;
  end if;

  if coalesce(p_has_duplicate_exclusion, false) then
    exclusion_reasons := exclusion_reasons || '"duplicate_exclusion"'::jsonb;
    blocking_reasons := blocking_reasons || '"duplicate_exclusion"'::jsonb;
  end if;

  if coalesce(p_has_blocking_needs_follow_up, false) then
    exclusion_reasons := exclusion_reasons || '"needs_follow_up"'::jsonb;
    blocking_reasons := blocking_reasons || '"other_open_review"'::jsonb;
  end if;

  -- reporting_decision (and therefore every financial total/count derived
  -- from it) is gated on exclusion_reasons, not blocking_reasons.
  -- exclusion_reasons is the exact set the pre-refactor TypeScript gate
  -- (b2cPaymentExclusionReasons) checked and never included date
  -- plausibility. blocking_reasons additionally carries
  -- missing_business_date/implausible_future_date for the per-row UI label
  -- only (matching the pre-refactor payment-decision.ts, which flagged
  -- these for display without excluding the payment from totals); letting
  -- them gate reporting_decision here would silently start excluding a
  -- future-dated payment from totals that the old system always counted.
  reporting_decision := case
    when coalesce(p_has_duplicate_exclusion, false) then 'excluded'
    when jsonb_array_length(exclusion_reasons) > 0 then 'blocked'
    when coalesce(p_has_finance_exception, false) then 'exception_included'
    else 'reportable'
  end;

  return jsonb_build_object(
    'source_status', p_payment_status,
    'reconciliation_status', case when coalesce(p_has_open_payment_duplicate, false) then 'duplicate_pending' else 'not_required' end,
    'reporting_decision', reporting_decision,
    'posting_status', case when p_source_system = 'finance_tracker' then 'posted' else 'not_applicable' end,
    'exclusion_reasons', exclusion_reasons,
    'blocking_reasons', blocking_reasons
  );
end;
$$;

revoke all on function public.b2c_payment_decision_reasons(
  text, text, text, numeric, boolean, boolean, boolean, boolean, boolean,
  text, date, date
) from public, anon;
grant execute on function public.b2c_payment_decision_reasons(
  text, text, text, numeric, boolean, boolean, boolean, boolean, boolean,
  text, date, date
) to authenticated;

create or replace function public.b2c_ledger_filter_records(
  p_period text,
  p_today date,
  p_payment_ids uuid[] default null,
  p_refund_ids uuid[] default null,
  p_include_row_data boolean default false
)
returns table (
  record_type text,
  record_id uuid,
  linked_payment_id uuid,
  date_value date,
  amount_value_usd numeric,
  source_system text,
  source_label text,
  source_status text,
  payment_status text,
  reporting_decision text,
  issue text,
  category text,
  original_currency text,
  foreign_currency_review boolean,
  customer_name text,
  customer_email text,
  customer_phone text,
  provider_reference text,
  decision jsonb,
  row_data jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with period as (
    select
      case when p_period = 'all' then null::date else (p_period || '-01')::date end as starts_on,
      case when p_period = 'all' then null::date else ((p_period || '-01')::date + interval '1 month - 1 day')::date end as ends_on
  ),
  payment_candidate_ids as (
    select payment.id
    from public.b2c_payments payment
    left join public.b2c_payment_local_overrides override_row
      on override_row.payment_id = payment.id
    cross join period
    where override_row.local_occurred_on is null
      and (p_payment_ids is null or payment.id = any(p_payment_ids))
      and (period.starts_on is null or payment.occurred_on between period.starts_on and period.ends_on)
    union all
    select payment.id
    from public.b2c_payment_local_overrides override_row
    join public.b2c_payments payment on payment.id = override_row.payment_id
    cross join period
    where override_row.local_occurred_on is not null
      and (p_payment_ids is null or payment.id = any(p_payment_ids))
      and (period.starts_on is null or override_row.local_occurred_on between period.starts_on and period.ends_on)
  ),
  refund_candidates as (
    select refund.*
    from public.b2c_refunds refund
    cross join period
    where (p_refund_ids is null or refund.id = any(p_refund_ids))
      and (
        period.starts_on is null
        or (refund.occurred_at at time zone 'UTC')::date between period.starts_on and period.ends_on
      )
  ),
  needed_payment_ids as (
    select id from payment_candidate_ids
    union
    select payment_id from refund_candidates
  ),
  duplicate_state as (
    select member.payment_id,
      bool_or(duplicate_group.status = 'open') as has_open_duplicate,
      bool_or(duplicate_group.status = 'resolved' and member.decision = 'exclude') as has_duplicate_exclusion
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id in (select id from needed_payment_ids)
    group by member.payment_id
  ),
  flag_state as (
    select flag.source_area, flag.source_record_id,
      bool_or(flag.flag_type = 'possible_duplicate') as has_possible_duplicate,
      bool_or(flag.flag_type = 'failed') as has_failed,
      bool_or(flag.flag_type = 'refunded') as has_refunded,
      bool_or(flag.flag_type = 'needs_follow_up' and flag.reason ~* 'missing a valid customer email') as has_missing_email,
      bool_or(flag.flag_type = 'needs_follow_up' and flag.reason !~* 'missing a valid customer email') as has_other_follow_up
    from public.review_flags flag
    where flag.status = 'open'
      and flag.flag_type <> 'unmapped_product'
      and (
        (flag.source_area = 'b2c_payment' and flag.source_record_id in (select id from needed_payment_ids))
        or
        (flag.source_area = 'b2c_refund' and flag.source_record_id in (select id from refund_candidates))
      )
    group by flag.source_area, flag.source_record_id
  ),
  payment_base as (
    select
      payment.*,
      coalesce(override_row.customer_name, payment.customer_name) as effective_customer_name,
      coalesce(override_row.customer_email, payment.customer_email)::text as effective_customer_email,
      coalesce(override_row.customer_phone, payment.customer_phone) as effective_customer_phone,
      coalesce(override_row.category_code, payment.category_code) as effective_category,
      coalesce(override_row.membership_tier, payment.membership_tier) as effective_membership_tier,
      coalesce(override_row.local_occurred_on, payment.occurred_on) as effective_occurred_on,
      case
        when payment.original_currency <> 'USD' then payment_fx.amount_usd
        else coalesce(override_row.local_amount_usd, payment_fx.amount_usd, payment.amount_usd)
      end as effective_amount_usd,
      payment_fx.conversion_source as fx_conversion_source,
      payment_fx.effective_on as fx_conversion_effective_on,
      payment_fx.id is not null as has_fx_conversion,
      coalesce(finance_exception.decision = 'include', false) as has_finance_exception,
      coalesce(duplicate_state.has_open_duplicate, false) as has_open_duplicate,
      coalesce(duplicate_state.has_duplicate_exclusion, false) as has_duplicate_exclusion,
      coalesce(payment_flags.has_possible_duplicate, false) as has_possible_duplicate_flag,
      coalesce(payment_flags.has_failed, false) as has_failed_flag,
      coalesce(payment_flags.has_refunded, false) as has_refunded_flag,
      coalesce(payment_flags.has_missing_email, false) as has_missing_email_flag,
      coalesce(payment_flags.has_other_follow_up, false) as has_other_follow_up,
      coalesce(
        override_row.customer_name,
        payment.customer_name,
        stripe_detail.payment_method_customer_name,
        stripe_detail.customer_profile_name
      ) as display_customer_name,
      coalesce(
        override_row.customer_email,
        payment.customer_email,
        stripe_detail.payment_method_customer_email,
        stripe_detail.customer_profile_email
      )::text as display_customer_email,
      coalesce(
        override_row.customer_phone,
        payment.customer_phone,
        stripe_detail.payment_method_customer_phone,
        stripe_detail.customer_profile_phone
      ) as display_customer_phone,
      case
        when coalesce(override_row.customer_name, payment.customer_name) is not null then null
        when stripe_detail.payment_method_customer_name is not null then 'Stripe payment method'
        when stripe_detail.customer_profile_name is not null then 'Stripe profile'
        else null
      end as customer_name_evidence_label,
      case
        when coalesce(override_row.customer_email, payment.customer_email) is not null then null
        when stripe_detail.payment_method_customer_email is not null then 'Stripe payment method'
        when stripe_detail.customer_profile_email is not null then 'Stripe profile'
        else null
      end as customer_email_evidence_label,
      case
        when coalesce(override_row.customer_phone, payment.customer_phone) is not null then null
        when stripe_detail.payment_method_customer_phone is not null then 'Stripe payment method'
        when stripe_detail.customer_profile_phone is not null then 'Stripe profile'
        else null
      end as customer_phone_evidence_label,
      coalesce(nullif(trim(stripe_detail.charge_description), ''), nullif(trim(payment.source_metadata ->> 'description'), '')) as source_description,
      stripe_detail.seller_message as source_seller_message,
      array_remove(array[
        case when override_row.customer_name is not null then 'customerName' end,
        case when override_row.customer_email is not null then 'customerEmail' end,
        case when override_row.customer_phone is not null then 'customerPhone' end,
        case when override_row.category_code is not null then 'categoryCode' end,
        case when override_row.membership_tier is not null then 'membershipTier' end,
        case when override_row.local_amount_usd is not null and payment.original_currency = 'USD' then 'amountUsd' end,
        case when override_row.local_occurred_on is not null then 'occurredOn' end
      ]::text[], null) as corrected_fields
    from needed_payment_ids needed
    join public.b2c_payments payment on payment.id = needed.id
    left join public.b2c_payment_local_overrides override_row on override_row.payment_id = payment.id
    left join duplicate_state on duplicate_state.payment_id = payment.id
    left join flag_state payment_flags
      on payment_flags.source_area = 'b2c_payment'
      and payment_flags.source_record_id = payment.id
    left join public.b2c_stripe_payment_details stripe_detail
      on stripe_detail.payment_id = payment.id
    left join lateral (
      select conversion.id, conversion.amount_usd, conversion.conversion_source, conversion.effective_on
      from public.b2c_payment_fx_conversions conversion
      where conversion.payment_id = payment.id
      order by conversion.created_at desc, conversion.id desc
      limit 1
    ) payment_fx on true
    left join lateral (
      select decision.decision
      from public.b2c_payment_finance_exception_decisions decision
      where decision.payment_id = payment.id
      order by decision.created_at desc, decision.id desc
      limit 1
    ) finance_exception on true
  ),
  payment_decisions as (
    select payment_base.*,
      public.b2c_payment_decision_reasons(
        payment_base.payment_status,
        payment_base.effective_customer_email,
        payment_base.original_currency::text,
        payment_base.effective_amount_usd,
        payment_base.has_finance_exception,
        payment_base.source_system = 'finance_tracker',
        payment_base.has_open_duplicate or payment_base.has_possible_duplicate_flag,
        payment_base.has_duplicate_exclusion,
        payment_base.has_other_follow_up,
        payment_base.source_system,
        payment_base.effective_occurred_on,
        p_today
      ) as payment_decision
    from payment_base
  ),
  payment_rows as (
    select
      'Payment'::text as record_type,
      payment.id as record_id,
      payment.id as linked_payment_id,
      payment.effective_occurred_on as date_value,
      payment.effective_amount_usd as amount_value_usd,
      payment.source_system,
      case
        when payment.source_system = 'stripe' then 'Stripe'
        when payment.source_system = 'tap' then 'Tap'
        when payment.source_system = 'manual_bank_transfer' then 'Manual bank transfer'
        when payment.source_metadata ->> 'finance_payment_method' = 'bank_transfer' then 'Finance — Bank transfer'
        when payment.source_metadata ->> 'finance_payment_method' = 'ios' then 'Finance — iOS'
        else 'Finance'
      end as source_label,
      payment.payment_decision ->> 'source_status' as source_status,
      case payment.payment_status when 'succeeded' then 'Completed' when 'failed' then 'Failed' else 'Pending' end as payment_status,
      payment.payment_decision ->> 'reporting_decision' as reporting_decision,
      case
        when payment.has_missing_email_flag and payment.display_customer_email is null then 'Missing customer email'
        when payment.has_possible_duplicate_flag then 'Possible duplicate'
        when payment.has_failed_flag then 'Failed'
        when payment.has_other_follow_up then 'Needs follow-up'
        when payment.has_refunded_flag then 'Refunded'
        else null
      end as issue,
      case when payment.effective_category is null or payment.effective_category = 'unmapped' then 'Unmapped' else payment.effective_category end as category,
      payment.original_currency::text as original_currency,
      payment.original_currency <> 'USD' and payment.effective_amount_usd is null as foreign_currency_review,
      payment.display_customer_name as customer_name,
      payment.display_customer_email as customer_email,
      payment.display_customer_phone as customer_phone,
      payment.provider_transaction_id as provider_reference,
      payment.payment_decision as decision,
      case when p_include_row_data then jsonb_build_object(
        'id', payment.id,
        'record_type', 'Payment',
        'customer_name', payment.display_customer_name,
        'customer_email', payment.display_customer_email,
        'customer_phone', payment.display_customer_phone,
        'customer_name_evidence_label', payment.customer_name_evidence_label,
        'customer_email_evidence_label', payment.customer_email_evidence_label,
        'customer_phone_evidence_label', payment.customer_phone_evidence_label,
        'date_value', payment.effective_occurred_on,
        'amount_value_usd', payment.effective_amount_usd::text,
        'source_original_amount', payment.original_amount::text,
        'source_original_currency', payment.original_currency::text,
        'source_description', payment.source_description,
        'source_seller_message', payment.source_seller_message,
        'foreign_currency_review', payment.original_currency <> 'USD' and payment.effective_amount_usd is null,
        'has_fx_conversion', payment.has_fx_conversion,
        'fx_conversion_source', payment.fx_conversion_source,
        'fx_conversion_effective_on', payment.fx_conversion_effective_on,
        'source_date_value', payment.occurred_on,
        'category', case when payment.effective_category is null or payment.effective_category = 'unmapped' then 'Unmapped' else payment.effective_category end,
        'membership_tier', payment.effective_membership_tier,
        'source', case
          when payment.source_system = 'stripe' then 'Stripe'
          when payment.source_system = 'tap' then 'Tap'
          when payment.source_system = 'manual_bank_transfer' then 'Manual bank transfer'
          when payment.source_metadata ->> 'finance_payment_method' = 'bank_transfer' then 'Finance — Bank transfer'
          when payment.source_metadata ->> 'finance_payment_method' = 'ios' then 'Finance — iOS'
          else 'Finance'
        end,
        'payment_status', case payment.payment_status when 'succeeded' then 'Completed' when 'failed' then 'Failed' else 'Pending' end,
        'provider_reference', payment.provider_transaction_id,
        'source_system', payment.source_system,
        'product_reference', nullif(trim(payment.source_metadata ->> 'product_reference'), ''),
        'source_metadata', payment.source_metadata,
        'has_local_correction', cardinality(payment.corrected_fields) > 0,
        'local_correction_fields', to_jsonb(payment.corrected_fields),
        'has_finance_exception', payment.has_finance_exception,
        'has_open_payment_duplicate', payment.has_open_duplicate,
        'has_duplicate_exclusion', payment.has_duplicate_exclusion,
        'open_review_flags', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', flag.id,
            'type', case
              when flag.flag_type = 'needs_fx_review' then 'Needs FX review'
              when flag.flag_type = 'possible_duplicate' then 'Possible duplicate'
              when flag.flag_type = 'failed' then 'Failed'
              when flag.flag_type = 'refunded' then 'Refunded'
              when flag.flag_type = 'needs_follow_up' and flag.reason ~* 'missing a valid customer email' then 'Missing customer email'
              else 'Needs follow-up'
            end,
            'reason', flag.reason
          ) order by flag.created_at, flag.id)
          from public.review_flags flag
          where flag.source_area = 'b2c_payment'
            and flag.source_record_id = payment.id
            and flag.status = 'open'
            and flag.flag_type <> 'unmapped_product'
            and not (
              flag.flag_type = 'needs_follow_up'
              and flag.reason ~* 'missing a valid customer email'
              and payment.display_customer_email is not null
            )
        ), '[]'::jsonb),
        'issue', case
          when payment.has_missing_email_flag and payment.display_customer_email is null then 'Missing customer email'
          when payment.has_possible_duplicate_flag then 'Possible duplicate'
          when payment.has_failed_flag then 'Failed'
          when payment.has_other_follow_up then 'Needs follow-up'
          when payment.has_refunded_flag then 'Refunded'
          else null
        end
      ) else null end as row_data
    from payment_decisions payment
    where payment.id in (select id from payment_candidate_ids)
  ),
  refund_rows as (
    select
      'Refund'::text as record_type,
      refund.id as record_id,
      refund.payment_id as linked_payment_id,
      (refund.occurred_at at time zone 'UTC')::date as date_value,
      -case
        when refund.original_currency = 'USD' then refund.amount_usd
        else refund_fx.amount_usd
      end as amount_value_usd,
      refund.source_system,
      case refund.source_system
        when 'stripe' then 'Stripe'
        when 'tap' then 'Tap'
        else 'Manual bank transfer'
      end as source_label,
      refund_decision.value ->> 'source_status' as source_status,
      'Refunded'::text as payment_status,
      refund_decision.value ->> 'reporting_decision' as reporting_decision,
      case
        when coalesce(refund_flags.has_missing_email, false) and payment.display_customer_email is null then 'Missing customer email'
        when coalesce(refund_flags.has_possible_duplicate, false) then 'Possible duplicate'
        when coalesce(refund_flags.has_failed, false) then 'Failed'
        when coalesce(refund_flags.has_other_follow_up, false) then 'Needs follow-up'
        when coalesce(refund_flags.has_refunded, false) then 'Refunded'
        else null
      end as issue,
      case when payment.effective_category = 'unmapped' then 'Unmapped' else coalesce(payment.effective_category, 'Unavailable') end as category,
      refund.original_currency::text as original_currency,
      refund.original_currency <> 'USD'
        and coalesce(refund_fx.amount_usd, refund.amount_usd) is null as foreign_currency_review,
      payment.display_customer_name as customer_name,
      payment.display_customer_email as customer_email,
      payment.display_customer_phone as customer_phone,
      refund.provider_refund_id as provider_reference,
      refund_decision.value as decision,
      case when p_include_row_data then jsonb_build_object(
        'id', refund.id,
        'record_type', 'Refund',
        'customer_name', payment.display_customer_name,
        'customer_email', payment.display_customer_email,
        'customer_phone', payment.display_customer_phone,
        'customer_name_evidence_label', payment.customer_name_evidence_label,
        'customer_email_evidence_label', payment.customer_email_evidence_label,
        'customer_phone_evidence_label', payment.customer_phone_evidence_label,
        'date_value', (refund.occurred_at at time zone 'UTC')::date,
        'amount_value_usd', case
          when refund.original_currency = 'USD' and refund.amount_usd is not null then (-refund.amount_usd)::text
          when refund_fx.amount_usd is not null then (-refund_fx.amount_usd)::text
          else null
        end,
        'source_original_amount', refund.original_amount::text,
        'source_original_currency', refund.original_currency::text,
        'source_description', null,
        'source_seller_message', null,
        'foreign_currency_review', refund.original_currency <> 'USD' and coalesce(refund_fx.amount_usd, refund.amount_usd) is null,
        'has_fx_conversion', refund_fx.id is not null,
        'fx_conversion_source', refund_fx.conversion_source,
        'fx_conversion_effective_on', refund_fx.effective_on,
        'source_date_value', (refund.occurred_at at time zone 'UTC')::date,
        'category', case when payment.effective_category = 'unmapped' then 'Unmapped' else coalesce(payment.effective_category, 'Unavailable') end,
        'membership_tier', payment.effective_membership_tier,
        'source', case refund.source_system when 'stripe' then 'Stripe' when 'tap' then 'Tap' else 'Manual bank transfer' end,
        'payment_status', 'Refunded',
        'provider_reference', refund.provider_refund_id,
        'source_system', refund.source_system,
        'product_reference', null,
        'source_metadata', '{}'::jsonb,
        'has_local_correction', cardinality(payment.corrected_fields) > 0,
        'local_correction_fields', to_jsonb(payment.corrected_fields),
        'has_finance_exception', payment.has_finance_exception,
        'has_open_payment_duplicate', payment.has_open_duplicate,
        'has_duplicate_exclusion', payment.has_duplicate_exclusion,
        'open_review_flags', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', flag.id,
            'type', case
              when flag.flag_type = 'needs_fx_review' then 'Needs FX review'
              when flag.flag_type = 'possible_duplicate' then 'Possible duplicate'
              when flag.flag_type = 'failed' then 'Failed'
              when flag.flag_type = 'refunded' then 'Refunded'
              when flag.flag_type = 'needs_follow_up' and flag.reason ~* 'missing a valid customer email' then 'Missing customer email'
              else 'Needs follow-up'
            end,
            'reason', flag.reason
          ) order by flag.created_at, flag.id)
          from public.review_flags flag
          where flag.source_area = 'b2c_refund'
            and flag.source_record_id = refund.id
            and flag.status = 'open'
            and flag.flag_type <> 'unmapped_product'
        ), '[]'::jsonb),
        'issue', case
          when coalesce(refund_flags.has_missing_email, false) and payment.display_customer_email is null then 'Missing customer email'
          when coalesce(refund_flags.has_possible_duplicate, false) then 'Possible duplicate'
          when coalesce(refund_flags.has_failed, false) then 'Failed'
          when coalesce(refund_flags.has_other_follow_up, false) then 'Needs follow-up'
          when coalesce(refund_flags.has_refunded, false) then 'Refunded'
          else null
        end
      ) else null end as row_data
    from refund_candidates refund
    join payment_decisions payment on payment.id = refund.payment_id
    left join flag_state refund_flags
      on refund_flags.source_area = 'b2c_refund'
      and refund_flags.source_record_id = refund.id
    left join lateral (
      select conversion.id, conversion.amount_usd, conversion.conversion_source, conversion.effective_on
      from public.b2c_refund_fx_conversions conversion
      where conversion.refund_id = refund.id
      order by conversion.created_at desc, conversion.id desc
      limit 1
    ) refund_fx on true
    cross join lateral (
      select public.b2c_payment_decision_reasons(
        'succeeded',
        payment.effective_customer_email,
        refund.original_currency::text,
        case when refund.original_currency = 'USD' then refund.amount_usd else refund_fx.amount_usd end,
        payment.has_finance_exception,
        refund.source_system = 'finance_tracker',
        payment.has_open_duplicate or coalesce(refund_flags.has_possible_duplicate, false),
        payment.has_duplicate_exclusion,
        coalesce(refund_flags.has_other_follow_up, false),
        refund.source_system,
        (refund.occurred_at at time zone 'UTC')::date,
        p_today
      ) as value
    ) refund_decision
  )
  select * from payment_rows
  union all
  select * from refund_rows;
$$;

revoke all on function public.b2c_ledger_filter_records(text, date, uuid[], uuid[], boolean) from public, anon, authenticated;

create or replace function public.get_b2c_ledger_rows(
  p_payment_ids uuid[],
  p_refund_ids uuid[],
  p_today date
)
returns table (
  record_type text,
  record_id uuid,
  row_data jsonb,
  decision jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;
  if p_today is null then
    raise exception 'B2C Ledger hydration requires today';
  end if;
  if coalesce(cardinality(p_payment_ids), 0) + coalesce(cardinality(p_refund_ids), 0) > 100 then
    raise exception 'B2C Ledger hydration is limited to 100 records';
  end if;

  return query
  select record.record_type, record.record_id, record.row_data, record.decision
  from public.b2c_ledger_filter_records(
    'all',
    p_today,
    coalesce(p_payment_ids, array[]::uuid[]),
    coalesce(p_refund_ids, array[]::uuid[]),
    true
  ) record
  order by record.record_type, record.record_id;
end;
$$;

revoke all on function public.get_b2c_ledger_rows(uuid[], uuid[], date) from public, anon;
grant execute on function public.get_b2c_ledger_rows(uuid[], uuid[], date) to authenticated;

create or replace function public.get_b2c_ledger_decisions(
  p_today date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  decisions jsonb;
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;
  if p_today is null then
    raise exception 'B2C Ledger decisions require today';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'record_type', record.record_type,
    'record_id', record.record_id,
    'decision', record.decision
  ) order by record.record_type, record.record_id), '[]'::jsonb)
  into decisions
  from public.b2c_ledger_filter_records('all', p_today) record
  ;
  return decisions;
end;
$$;

revoke all on function public.get_b2c_ledger_decisions(date) from public, anon;
grant execute on function public.get_b2c_ledger_decisions(date) to authenticated;

create or replace function public.get_b2c_ledger_page(
  p_period text default null,
  p_today date default current_date,
  p_limit integer default 25,
  p_sort text default 'date_desc',
  p_after_value text default null,
  p_after_record_type text default null,
  p_after_id uuid default null,
  p_source text default null,
  p_source_status text default null,
  p_payment_status text default null,
  p_reporting_decision text default null,
  p_issue text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_category text default null,
  p_foreign_currency_only boolean default false,
  p_currency text default null,
  p_min_amount_usd numeric default null,
  p_max_amount_usd numeric default null,
  p_search text default null
)
returns table (
  record_type text,
  record_id uuid,
  sort_value text,
  decision jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;
  if p_period is null or (p_period <> 'all' and p_period !~ '^\d{4}-(0[1-9]|1[0-2])$') then
    raise exception 'Invalid B2C reporting period';
  end if;
  if p_limit not between 1 and 101 then
    raise exception 'Invalid B2C Ledger page limit';
  end if;
  if p_sort not in ('date_desc', 'date_asc', 'amount_desc', 'amount_asc') then
    raise exception 'Invalid B2C Ledger sort';
  end if;

  return query
  with filtered as (
    select record.*,
      case when record.record_type = 'Payment' then 0 else 1 end as kind_order,
      coalesce(record.amount_value_usd, 0) as sortable_amount
    from public.b2c_ledger_filter_records(p_period, p_today) record
    where (p_source is null or record.source_system = p_source)
      and (p_source_status is null or record.source_status = p_source_status)
      and (p_payment_status is null or record.payment_status = p_payment_status)
      and (p_reporting_decision is null or record.reporting_decision = p_reporting_decision)
      and (p_issue is null or (p_issue = 'none' and record.issue is null) or (p_issue <> 'none' and record.issue = p_issue))
      and (p_date_from is null or record.date_value >= p_date_from)
      and (p_date_to is null or record.date_value <= p_date_to)
      and (p_category is null or record.category = p_category)
      and (not p_foreign_currency_only or record.foreign_currency_review)
      and (p_currency is null or record.original_currency = p_currency)
      and (p_min_amount_usd is null or abs(record.amount_value_usd) >= p_min_amount_usd)
      and (p_max_amount_usd is null or abs(record.amount_value_usd) <= p_max_amount_usd)
      and (
        nullif(trim(p_search), '') is null
        or concat_ws(' ', record.customer_name, record.customer_email, record.customer_phone, record.provider_reference)
          ilike '%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      )
  ),
  after_cursor as (
    select
      case when p_after_record_type = 'Payment' then 0 else 1 end as kind_order,
      p_after_id as record_id,
      case when p_sort like 'date_%' and p_after_value is not null then p_after_value::date end as date_value,
      case when p_sort like 'amount_%' and p_after_value is not null then p_after_value::numeric end as amount_value
  )
  select
    filtered.record_type,
    filtered.record_id,
    case when p_sort like 'date_%' then filtered.date_value::text else filtered.sortable_amount::text end,
    filtered.decision
  from filtered
  cross join after_cursor cursor_row
  where p_after_value is null
    or (
      p_sort = 'date_desc' and (
        filtered.date_value < cursor_row.date_value
        or (filtered.date_value = cursor_row.date_value and filtered.kind_order > cursor_row.kind_order)
        or (filtered.date_value = cursor_row.date_value and filtered.kind_order = cursor_row.kind_order and filtered.record_id > cursor_row.record_id)
      )
    )
    or (
      p_sort = 'date_asc' and (
        filtered.date_value > cursor_row.date_value
        or (filtered.date_value = cursor_row.date_value and filtered.kind_order > cursor_row.kind_order)
        or (filtered.date_value = cursor_row.date_value and filtered.kind_order = cursor_row.kind_order and filtered.record_id > cursor_row.record_id)
      )
    )
    or (
      p_sort = 'amount_desc' and (
        filtered.sortable_amount < cursor_row.amount_value
        or (filtered.sortable_amount = cursor_row.amount_value and filtered.kind_order > cursor_row.kind_order)
        or (filtered.sortable_amount = cursor_row.amount_value and filtered.kind_order = cursor_row.kind_order and filtered.record_id > cursor_row.record_id)
      )
    )
    or (
      p_sort = 'amount_asc' and (
        filtered.sortable_amount > cursor_row.amount_value
        or (filtered.sortable_amount = cursor_row.amount_value and filtered.kind_order > cursor_row.kind_order)
        or (filtered.sortable_amount = cursor_row.amount_value and filtered.kind_order = cursor_row.kind_order and filtered.record_id > cursor_row.record_id)
      )
    )
  order by
    case when p_sort = 'date_desc' then filtered.date_value end desc,
    case when p_sort = 'date_asc' then filtered.date_value end asc,
    case when p_sort = 'amount_desc' then filtered.sortable_amount end desc,
    case when p_sort = 'amount_asc' then filtered.sortable_amount end asc,
    filtered.kind_order,
    filtered.record_id
  limit p_limit;
end;
$$;

create or replace function public.get_b2c_ledger_metadata(
  p_period text default null,
  p_today date default current_date,
  p_source text default null,
  p_source_status text default null,
  p_payment_status text default null,
  p_reporting_decision text default null,
  p_issue text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_category text default null,
  p_foreign_currency_only boolean default false,
  p_currency text default null,
  p_min_amount_usd numeric default null,
  p_max_amount_usd numeric default null,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;
  if p_period is null or (p_period <> 'all' and p_period !~ '^\d{4}-(0[1-9]|1[0-2])$') then
    raise exception 'Invalid B2C reporting period';
  end if;

  with base as materialized (
    select * from public.b2c_ledger_filter_records(p_period, p_today)
  ),
  filtered as (
    select record.*
    from base record
    where (p_source is null or record.source_system = p_source)
      and (p_source_status is null or record.source_status = p_source_status)
      and (p_payment_status is null or record.payment_status = p_payment_status)
      and (p_reporting_decision is null or record.reporting_decision = p_reporting_decision)
      and (p_issue is null or (p_issue = 'none' and record.issue is null) or (p_issue <> 'none' and record.issue = p_issue))
      and (p_date_from is null or record.date_value >= p_date_from)
      and (p_date_to is null or record.date_value <= p_date_to)
      and (p_category is null or record.category = p_category)
      and (not p_foreign_currency_only or record.foreign_currency_review)
      and (p_currency is null or record.original_currency = p_currency)
      and (p_min_amount_usd is null or abs(record.amount_value_usd) >= p_min_amount_usd)
      and (p_max_amount_usd is null or abs(record.amount_value_usd) <= p_max_amount_usd)
      and (
        nullif(trim(p_search), '') is null
        or concat_ws(' ', record.customer_name, record.customer_email, record.customer_phone, record.provider_reference)
          ilike '%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      )
  )
  select jsonb_build_object(
    'total_count', (select count(*) from filtered),
    'sources', coalesce((select jsonb_agg(value order by value) from (select distinct source_label as value from base) values_row), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(value order by value) from (select distinct category as value from base) values_row), '[]'::jsonb),
    'issues', coalesce((select jsonb_agg(value order by value) from (select distinct issue as value from base where issue is not null) values_row), '[]'::jsonb),
    'foreign_currency_count', (select count(*) filter (where foreign_currency_review) from base)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_b2c_ledger_page(
  text, date, integer, text, text, text, uuid, text, text, text, text, text,
  date, date, text, boolean, text, numeric, numeric, text
) from public, anon;
grant execute on function public.get_b2c_ledger_page(
  text, date, integer, text, text, text, uuid, text, text, text, text, text,
  date, date, text, boolean, text, numeric, numeric, text
) to authenticated;

revoke all on function public.get_b2c_ledger_metadata(
  text, date, text, text, text, text, text, date, date, text, boolean, text,
  numeric, numeric, text
) from public, anon;
grant execute on function public.get_b2c_ledger_metadata(
  text, date, text, text, text, text, text, date, date, text, boolean, text,
  numeric, numeric, text
) to authenticated;

create or replace function public.b2c_dashboard_summary_data(
  p_period text,
  p_today date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with period_records as materialized (
    select * from public.b2c_ledger_filter_records(p_period, p_today)
  ),
  linked_payment_decisions as materialized (
    select record_id as payment_id, decision
    from public.b2c_ledger_filter_records(
      'all',
      p_today,
      coalesce((
        select array_agg(distinct linked_payment_id)
        from period_records
        where record_type = 'Refund'
      ), array[]::uuid[]),
      array[]::uuid[]
    )
    where record_type = 'Payment'
  ),
  payment_totals as (
    select
      coalesce(sum(record.amount_value_usd) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision in ('reportable', 'exception_included')
      ), 0)::numeric(20,6) as eligible_payments_usd,
      coalesce(sum(payment.amount_usd) filter (
        where record.source_status = 'succeeded'
          and payment.original_currency = 'USD'
          and payment.amount_usd is not null
      ), 0)::numeric(20,6) as completed_source_payments_usd,
      coalesce(sum(record.amount_value_usd) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision not in ('reportable', 'exception_included')
          and record.amount_value_usd is not null
      ), 0)::numeric(20,6) as excluded_completed_payments_usd,
      count(*) filter (where record.source_status = 'succeeded')::integer as completed_source_payment_count,
      count(*) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision in ('reportable', 'exception_included')
      )::integer as reportable_payment_count,
      count(*) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision not in ('reportable', 'exception_included')
      )::integer as excluded_completed_payment_count,
      count(*) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision not in ('reportable', 'exception_included')
          and record.decision -> 'exclusion_reasons' ? 'missing_customer_email'
      )::integer as missing_customer_email_count,
      count(*) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision not in ('reportable', 'exception_included')
          and record.decision -> 'exclusion_reasons' ? 'possible_duplicate'
      )::integer as possible_duplicate_count,
      count(*) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision not in ('reportable', 'exception_included')
          and record.decision -> 'exclusion_reasons' ? 'needs_follow_up'
          and not (record.decision -> 'exclusion_reasons' ? 'missing_customer_email')
      )::integer as other_review_count,
      count(*) filter (where record.source_status <> 'succeeded')::integer as non_succeeded_payment_count,
      count(*) filter (
        where record.source_status = 'succeeded'
          and record.reporting_decision = 'exception_included'
      )::integer as finance_exception_payment_count
    from period_records record
    join public.b2c_payments payment on payment.id = record.record_id
    where record.record_type = 'Payment'
  ),
  refund_totals as (
    select
      coalesce(sum(abs(record.amount_value_usd)) filter (
        where linked.decision ->> 'reporting_decision' in ('reportable', 'exception_included')
          and record.amount_value_usd is not null
      ), 0)::numeric(20,6) as refunds_usd,
      coalesce(sum(refund.amount_usd) filter (
        where refund.original_currency = 'USD' and refund.amount_usd is not null
      ), 0)::numeric(20,6) as source_refunds_usd,
      count(*)::integer as source_refund_count,
      count(*) filter (
        where linked.decision ->> 'reporting_decision' in ('reportable', 'exception_included')
          and record.amount_value_usd is not null
      )::integer as eligible_refund_count
    from period_records record
    join public.b2c_refunds refund on refund.id = record.record_id
    left join linked_payment_decisions linked on linked.payment_id = record.linked_payment_id
    where record.record_type = 'Refund'
  ),
  stripe_historical as (
    select run.*
    from public.integration_sync_runs run
    where run.provider = 'stripe' and run.operation_type = 'historical_backfill'
    order by run.created_at desc
    limit 1
  ),
  stripe_reconciliation as (
    select run.*
    from public.integration_sync_runs run
    where run.provider = 'stripe' and run.operation_type = 'reconciliation'
    order by run.created_at desc
    limit 1
  ),
  tap_historical as (
    select run.*
    from public.integration_sync_runs run
    where run.provider = 'tap' and run.operation_type = 'historical_backfill'
    order by run.created_at desc
    limit 1
  ),
  tap_reconciliation as (
    select run.*
    from public.integration_sync_runs run
    where run.provider = 'tap' and run.operation_type = 'reconciliation'
    order by run.created_at desc
    limit 1
  )
  select jsonb_build_object(
    'has_source_records', exists (select 1 from public.b2c_payments) or exists (select 1 from public.b2c_refunds),
    'eligible_payments_usd', payment_totals.eligible_payments_usd::text,
    'refunds_usd', refund_totals.refunds_usd::text,
    'net_payments_usd', (payment_totals.eligible_payments_usd - refund_totals.refunds_usd)::numeric(20,6)::text,
    'completed_source_payments_usd', payment_totals.completed_source_payments_usd::text,
    'source_refunds_usd', refund_totals.source_refunds_usd::text,
    'calculation', jsonb_build_object(
      'completed_source_payment_count', payment_totals.completed_source_payment_count,
      'reportable_payment_count', payment_totals.reportable_payment_count,
      'excluded_completed_payment_count', payment_totals.excluded_completed_payment_count,
      'excluded_completed_payments_usd', payment_totals.excluded_completed_payments_usd::text,
      'source_refund_count', refund_totals.source_refund_count,
      'eligible_refund_count', refund_totals.eligible_refund_count,
      'missing_customer_email_count', payment_totals.missing_customer_email_count,
      'possible_duplicate_count', payment_totals.possible_duplicate_count,
      'other_review_count', payment_totals.other_review_count,
      'non_succeeded_payment_count', payment_totals.non_succeeded_payment_count,
      'finance_exception_payment_count', payment_totals.finance_exception_payment_count
    ),
    'review_items', (
      select count(*) from public.review_flags
      where status = 'open'
        and source_area in ('b2c_payment', 'b2c_refund')
        and flag_type <> 'unmapped_product'
    ),
    'source_coverage_inputs', jsonb_build_object(
      'providers', jsonb_build_array(
        jsonb_build_object(
          'provider', 'stripe',
          'active', exists (select 1 from public.b2c_payments where source_system = 'stripe')
            or exists (select 1 from public.b2c_refunds where source_system = 'stripe')
            or exists (select 1 from stripe_historical),
          'historicalBackfill', (
            select jsonb_build_object(
              'status', status,
              'recordsFailed', records_failed,
              'completedAt', completed_at
            ) from stripe_historical
          ),
          'latestReconciliation', (
            select jsonb_build_object(
              'status', status,
              'requestedRangeEnd', requested_range_end,
              'completedAt', completed_at
            ) from stripe_reconciliation
          )
        ),
        jsonb_build_object(
          'provider', 'tap',
          'active', exists (select 1 from public.b2c_payments where source_system = 'tap')
            or exists (select 1 from public.b2c_refunds where source_system = 'tap')
            or exists (select 1 from tap_historical),
          'historicalBackfill', (
            select jsonb_build_object(
              'status', status,
              'recordsFailed', records_failed,
              'completedAt', completed_at
            ) from tap_historical
          ),
          'latestReconciliation', (
            select jsonb_build_object(
              'status', status,
              'requestedRangeEnd', requested_range_end,
              'completedAt', completed_at
            ) from tap_reconciliation
          )
        )
      )
    )
  )
  from payment_totals
  cross join refund_totals;
$$;

revoke all on function public.b2c_dashboard_summary_data(text, date) from public, anon, authenticated;

create or replace function public.get_b2c_dashboard_summary(
  p_period text,
  p_today date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;
  if p_period is null or (p_period <> 'all' and p_period !~ '^\d{4}-(0[1-9]|1[0-2])$') then
    raise exception 'Invalid B2C reporting period';
  end if;
  if p_today is null then
    raise exception 'A B2C summary requires today';
  end if;
  return public.b2c_dashboard_summary_data(p_period, p_today);
end;
$$;

revoke all on function public.get_b2c_dashboard_summary(text, date) from public, anon;
grant execute on function public.get_b2c_dashboard_summary(text, date) to authenticated;

create or replace function public.get_b2c_payment_evidence(
  p_payment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  evidence jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin access is required';
  end if;
  if p_payment_id is null then
    raise exception 'A B2C payment ID is required';
  end if;

  select jsonb_build_object(
    'payment_id', payment.id,
    'source', case
      when payment.source_system = 'stripe' then 'Stripe'
      when payment.source_system = 'tap' then 'Tap'
      when payment.source_system = 'manual_bank_transfer' then 'Manual bank transfer'
      when payment.source_metadata ->> 'finance_payment_method' = 'bank_transfer' then 'Finance — Bank transfer'
      when payment.source_metadata ->> 'finance_payment_method' = 'ios' then 'Finance — iOS'
      else 'Finance'
    end,
    'source_system', payment.source_system,
    'provider_reference', payment.provider_transaction_id,
    'date_value', coalesce(override.local_occurred_on, payment.occurred_on),
    'stripe_evidence', case when payment.source_system = 'stripe' then jsonb_build_object(
      'originalAmount', payment.original_amount::text,
      'originalCurrency', payment.original_currency::text,
      'amountRefunded', stripe.charge_refunded_amount::text,
      'description', stripe.charge_description,
      'sellerMessage', stripe.seller_message,
      'cardholderName', stripe.cardholder_name,
      'settlementGrossAmount', stripe.settlement_gross_amount::text,
      'settlementFeeAmount', stripe.settlement_fee_amount::text,
      'settlementFeeTaxAmount', stripe.settlement_fee_tax_amount::text,
      'settlementNetAmount', stripe.settlement_net_amount::text,
      'settlementCurrency', stripe.settlement_currency::text,
      'settlementExchangeRate', stripe.settlement_exchange_rate::text,
      'refunds', coalesce((
        select jsonb_agg(jsonb_build_object(
          'refundId', refund.id,
          'originalAmount', refund.original_amount::text,
          'originalCurrency', refund.original_currency::text,
          'settlementRefundAmount', refund_stripe.settlement_refund_amount::text,
          'settlementCurrency', refund_stripe.settlement_currency::text,
          'settlementExchangeRate', refund_stripe.settlement_exchange_rate::text
        ) order by refund.occurred_at, refund.id)
        from public.b2c_refunds refund
        left join public.b2c_stripe_refund_details refund_stripe
          on refund_stripe.refund_id = refund.id
        where refund.payment_id = payment.id
          and refund.source_system = 'stripe'
      ), '[]'::jsonb)
    ) else null end
  )
  into evidence
  from public.b2c_payments payment
  left join public.b2c_payment_local_overrides override on override.payment_id = payment.id
  left join public.b2c_stripe_payment_details stripe on stripe.payment_id = payment.id
  where payment.id = p_payment_id;

  return evidence;
end;
$$;

revoke all on function public.get_b2c_payment_evidence(uuid) from public, anon;
grant execute on function public.get_b2c_payment_evidence(uuid) to authenticated;
