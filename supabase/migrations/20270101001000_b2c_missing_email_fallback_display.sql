-- ---------------------------------------------------------------------------
-- Fix: a payment with a Stripe-profile-derived fallback display email was
-- silently hidden from "Missing customer email" everywhere -- the Ledger's
-- Issue badge, the Issue filter, AND the drawer's "Include in PLAYBOOK
-- Finance" exception panel (b2c-payment-review-actions.tsx gates that panel
-- on finding a "Missing customer email" entry in open_review_flags). The
-- payment's real, stored customer_email can still be null (correctly keeping
-- it out of Reportable Cash -- b2c_dashboard_summary_data's
-- missing_customer_email_count already reads exclusion_reasons directly and
-- was never affected by this bug), while the Admin sees a helpful fallback
-- email pulled live from the customer's current Stripe profile for display.
-- That fallback previously made the "Missing customer email" indicator (and
-- with it, the only UI path to resolve the payment) disappear entirely,
-- exactly when it was needed: whenever a fallback happens to exist, which is
-- the common case, not the rare one.
--
-- Confirmed directly against production before writing this fix: payment
-- 214efc30-b3cb-42f9-a789-4ffd0f7f1e22 (Arshiya Kherani) has
-- customer_email = null and a genuinely open review_flags row
-- ('needs_follow_up', reason mentions "missing a valid customer email"), yet
-- b2c_ledger_filter_records returned open_review_flags = [] and issue = null
-- for it -- solely because a Stripe customer-profile email was available for
-- display. Every occurrence of the same
-- `and payment.display_customer_email is null` /
-- `and payment.display_customer_email is not null` guard is removed below;
-- nothing else about this function changes (diffed against the prior
-- definition in 20270101000600_b2c_ledger_keyset_reads.sql to confirm this).
--
-- This does not change Reportable Cash by itself -- it only makes the
-- existing, audited "Include in PLAYBOOK Finance" exception decision
-- reachable for records that already qualify. Reportable Cash only changes
-- when an Admin actually approves that exception for a specific record.
-- ---------------------------------------------------------------------------

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
        when payment.has_missing_email_flag then 'Missing customer email'
        when payment.has_possible_duplicate_flag then 'Possible duplicate'
        when payment.has_failed_flag then 'Failed'
        when payment.has_other_follow_up then 'Needs follow-up'
        when payment.has_refunded_flag then 'Refunded'
        else null
      end as issue,
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
        ), '[]'::jsonb),
        'issue', case
          when payment.has_missing_email_flag then 'Missing customer email'
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
        when coalesce(refund_flags.has_missing_email, false) then 'Missing customer email'
        when coalesce(refund_flags.has_possible_duplicate, false) then 'Possible duplicate'
        when coalesce(refund_flags.has_failed, false) then 'Failed'
        when coalesce(refund_flags.has_other_follow_up, false) then 'Needs follow-up'
        when coalesce(refund_flags.has_refunded, false) then 'Refunded'
        else null
      end as issue,
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
          when coalesce(refund_flags.has_missing_email, false) then 'Missing customer email'
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

