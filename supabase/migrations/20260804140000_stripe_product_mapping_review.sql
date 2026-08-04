-- Stripe remains a read-only provider. These routines change only local
-- PLAYBOOK classification and review state, while triggers retain full audit
-- snapshots under the authenticated Admin actor.

create index if not exists b2c_payments_stripe_product_reference_idx
  on public.b2c_payments ((source_metadata ->> 'product_reference'))
  where source_system = 'stripe';

-- Use one canonical six-decimal fingerprint representation. This keeps the
-- two required duplicate checks stable when an Admin maps a previously
-- unmapped Stripe product locally.
update public.b2c_payments
set duplicate_fingerprint = encode(digest(
  coalesce(lower(customer_email::text), 'missing-email:' || coalesce(provider_transaction_id, id::text))
  || '|' || amount_usd::text
  || '|' || lower(btrim(category_code))
  || '|' || occurred_on::text,
  'sha256'
), 'hex');

create or replace function public.apply_stripe_product_mapping(
  p_external_product_id text,
  p_internal_product_code text,
  p_internal_product_name text,
  p_category_code text,
  p_membership_tier text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_mapping public.product_mappings%rowtype;
  previous_mapping public.product_mappings%rowtype;
  target_product_id uuid;
  target_payment public.b2c_payments%rowtype;
  affected_payment_count integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can map a Stripe product locally';
  end if;
  if char_length(trim(p_external_product_id)) = 0
    or char_length(trim(p_internal_product_code)) = 0
    or char_length(trim(p_internal_product_name)) = 0
    or char_length(trim(p_category_code)) = 0
    or char_length(trim(p_reason)) = 0 then
    raise exception 'Stripe product, internal product, category, and audit reason are required';
  end if;
  if trim(p_internal_product_code) !~ '^[a-z0-9][a-z0-9_-]*$'
    or trim(p_category_code) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Internal product and category codes must use lowercase letters, numbers, hyphens, or underscores';
  end if;

  insert into public.products (internal_code, name)
  values (trim(p_internal_product_code), trim(p_internal_product_name))
  on conflict (internal_code) do update
    set name = excluded.name,
        active = true
  returning id into target_product_id;

  select * into previous_mapping
  from public.product_mappings
  where source_system = 'stripe'
    and external_product_id = trim(p_external_product_id)
  for update;

  insert into public.product_mappings (
    source_system, external_product_id, product_id, category_code,
    membership_tier, created_by, updated_by
  ) values (
    'stripe', trim(p_external_product_id), target_product_id,
    trim(p_category_code), nullif(trim(p_membership_tier), ''), auth.uid(), auth.uid()
  ) on conflict (source_system, external_product_id) do update set
    product_id = excluded.product_id,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    updated_by = auth.uid()
  returning * into target_mapping;

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'product_mapping', target_mapping.id, 'classification',
    case when previous_mapping.id is null then '{}'::jsonb else jsonb_build_object(
      'external_product_id', previous_mapping.external_product_id,
      'product_id', previous_mapping.product_id,
      'category_code', previous_mapping.category_code,
      'membership_tier', previous_mapping.membership_tier
    ) end,
    jsonb_build_object(
      'external_product_id', target_mapping.external_product_id,
      'product_id', target_mapping.product_id,
      'category_code', target_mapping.category_code,
      'membership_tier', target_mapping.membership_tier
    ),
    trim(p_reason), current_date
  );

  -- Existing source records retain their Stripe payload metadata and provider
  -- IDs. Only the local reporting classification is updated, with one audited
  -- correction row per affected source payment.
  for target_payment in
    select * from public.b2c_payments
    where source_system = 'stripe'
      and source_metadata ->> 'product_reference' = trim(p_external_product_id)
    for update
  loop
    update public.b2c_payments
    set product_mapping_id = target_mapping.id,
        category_code = target_mapping.category_code,
        membership_tier = target_mapping.membership_tier,
        duplicate_fingerprint = encode(digest(
          coalesce(lower(target_payment.customer_email::text), 'missing-email:' || coalesce(target_payment.provider_transaction_id, target_payment.id::text))
          || '|' || target_payment.amount_usd::text
          || '|' || lower(target_mapping.category_code)
          || '|' || target_payment.occurred_on::text,
          'sha256'
        ), 'hex')
    where id = target_payment.id;

    insert into public.financial_corrections (
      target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
    ) values (
      'b2c_payment', target_payment.id, 'classification',
      jsonb_build_object('product_mapping_id', target_payment.product_mapping_id, 'category_code', target_payment.category_code, 'membership_tier', target_payment.membership_tier),
      jsonb_build_object('product_mapping_id', target_mapping.id, 'category_code', target_mapping.category_code, 'membership_tier', target_mapping.membership_tier),
      trim(p_reason), target_payment.occurred_on
    );
    affected_payment_count := affected_payment_count + 1;
  end loop;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select flag.id, 'resolved', trim(p_reason)
  from public.review_flags flag
  join public.b2c_payments payment on payment.id = flag.source_record_id
  where flag.source_area = 'b2c_payment'
    and flag.flag_type = 'unmapped_product'
    and flag.status = 'open'
    and payment.source_system = 'stripe'
    and payment.source_metadata ->> 'product_reference' = trim(p_external_product_id)
  on conflict (flag_id) do nothing;

  return target_mapping.id;
end;
$$;

create or replace function public.resolve_b2c_review_flag(
  p_flag_id uuid,
  p_resolution_status public.review_flag_status,
  p_resolution_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can resolve a B2C review item';
  end if;
  if p_resolution_status not in ('resolved', 'dismissed') or char_length(trim(p_resolution_note)) = 0 then
    raise exception 'A resolution status and note are required';
  end if;
  if not exists (
    select 1 from public.review_flags
    where id = p_flag_id
      and source_area in ('b2c_payment', 'b2c_refund')
      and status = 'open'
  ) then
    raise exception 'The B2C review item is unavailable or already resolved';
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  values (p_flag_id, p_resolution_status, trim(p_resolution_note));
end;
$$;

revoke all on function public.apply_stripe_product_mapping(text, text, text, text, text, text) from public;
revoke all on function public.resolve_b2c_review_flag(uuid, public.review_flag_status, text) from public;
grant execute on function public.apply_stripe_product_mapping(text, text, text, text, text, text) to authenticated;
grant execute on function public.resolve_b2c_review_flag(uuid, public.review_flag_status, text) to authenticated;
