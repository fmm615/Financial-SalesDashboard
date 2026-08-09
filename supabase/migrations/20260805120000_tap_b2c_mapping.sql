-- Tap remains a read-only source. This adds only local PLAYBOOK mapping state.
create index if not exists b2c_payments_tap_product_reference_idx
  on public.b2c_payments ((source_metadata ->> 'product_reference'))
  where source_system = 'tap';

create or replace function public.apply_b2c_product_mapping(
  p_source_system text,
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
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can map a B2C provider product locally';
  end if;
  if p_source_system = 'stripe' then
    return public.apply_stripe_product_mapping(p_external_product_id, p_internal_product_code, p_internal_product_name, p_category_code, p_membership_tier, p_reason);
  end if;
  if p_source_system <> 'tap' then
    raise exception 'Unsupported B2C source system';
  end if;
  if char_length(trim(p_external_product_id)) = 0
    or char_length(trim(p_internal_product_code)) = 0
    or char_length(trim(p_internal_product_name)) = 0
    or char_length(trim(p_category_code)) = 0
    or char_length(trim(p_reason)) = 0 then
    raise exception 'Tap product, internal product, category, and audit reason are required';
  end if;
  if trim(p_internal_product_code) !~ '^[a-z0-9][a-z0-9_-]*$'
    or trim(p_category_code) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Internal product and category codes must use lowercase letters, numbers, hyphens, or underscores';
  end if;

  insert into public.products (internal_code, name)
  values (trim(p_internal_product_code), trim(p_internal_product_name))
  on conflict (internal_code) do update set name = excluded.name, active = true
  returning id into target_product_id;

  select * into previous_mapping from public.product_mappings
  where source_system = 'tap' and external_product_id = trim(p_external_product_id)
  for update;

  insert into public.product_mappings (
    source_system, external_product_id, product_id, category_code, membership_tier, created_by, updated_by
  ) values (
    'tap', trim(p_external_product_id), target_product_id, trim(p_category_code), nullif(trim(p_membership_tier), ''), auth.uid(), auth.uid()
  ) on conflict (source_system, external_product_id) do update set
    product_id = excluded.product_id,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    updated_by = auth.uid()
  returning * into target_mapping;

  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
  values (
    'product_mapping', target_mapping.id, 'classification',
    case when previous_mapping.id is null then '{}'::jsonb else jsonb_build_object('external_product_id', previous_mapping.external_product_id, 'product_id', previous_mapping.product_id, 'category_code', previous_mapping.category_code, 'membership_tier', previous_mapping.membership_tier) end,
    jsonb_build_object('source_system', 'tap', 'external_product_id', target_mapping.external_product_id, 'product_id', target_mapping.product_id, 'category_code', target_mapping.category_code, 'membership_tier', target_mapping.membership_tier),
    trim(p_reason), current_date
  );

  for target_payment in
    select * from public.b2c_payments
    where source_system = 'tap' and source_metadata ->> 'product_reference' = trim(p_external_product_id)
    for update
  loop
    update public.b2c_payments set
      product_mapping_id = target_mapping.id,
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

    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values (
      'b2c_payment', target_payment.id, 'classification',
      jsonb_build_object('product_mapping_id', target_payment.product_mapping_id, 'category_code', target_payment.category_code, 'membership_tier', target_payment.membership_tier),
      jsonb_build_object('product_mapping_id', target_mapping.id, 'category_code', target_mapping.category_code, 'membership_tier', target_mapping.membership_tier),
      trim(p_reason), target_payment.occurred_on
    );
  end loop;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select flag.id, 'resolved', trim(p_reason)
  from public.review_flags flag
  join public.b2c_payments payment on payment.id = flag.source_record_id
  where flag.source_area = 'b2c_payment' and flag.flag_type = 'unmapped_product' and flag.status = 'open'
    and payment.source_system = 'tap' and payment.source_metadata ->> 'product_reference' = trim(p_external_product_id)
  on conflict (flag_id) do nothing;

  return target_mapping.id;
end;
$$;

revoke all on function public.apply_b2c_product_mapping(text, text, text, text, text, text, text) from public;
grant execute on function public.apply_b2c_product_mapping(text, text, text, text, text, text, text) to authenticated;
