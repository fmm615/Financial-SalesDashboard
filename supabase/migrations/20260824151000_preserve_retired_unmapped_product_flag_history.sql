create or replace function public.apply_b2c_payment_local_correction(
  p_payment_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_category_code text,
  p_membership_tier text,
  p_local_amount_usd numeric(20, 6),
  p_local_occurred_on date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  prior_override public.b2c_payment_local_overrides%rowtype;
  effective_customer_name text;
  effective_customer_email citext;
  effective_customer_phone text;
  effective_category_code text;
  effective_membership_tier text;
  effective_amount_usd numeric(20, 6);
  effective_occurred_on date;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a local B2C correction';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A correction reason must be between 3 and 1000 characters';
  end if;
  if p_customer_name is null and p_customer_email is null and p_customer_phone is null
    and p_category_code is null and p_membership_tier is null
    and p_local_amount_usd is null and p_local_occurred_on is null then
    raise exception 'Enter at least one verified local correction';
  end if;
  if p_customer_name is not null and char_length(trim(p_customer_name)) not between 1 and 200 then
    raise exception 'Customer name must be between 1 and 200 characters';
  end if;
  if p_customer_email is not null and trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid customer email';
  end if;
  if p_customer_phone is not null and char_length(trim(p_customer_phone)) not between 5 and 40 then
    raise exception 'Customer mobile must be between 5 and 40 characters';
  end if;
  if p_category_code is not null and lower(trim(p_category_code)) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Category must use lowercase letters, numbers, hyphens, or underscores';
  end if;
  if p_membership_tier is not null and char_length(trim(p_membership_tier)) not between 1 and 100 then
    raise exception 'Membership tier must be between 1 and 100 characters';
  end if;
  if p_local_amount_usd is not null and p_local_amount_usd <= 0 then
    raise exception 'Local USD amount must be greater than zero';
  end if;

  -- Keep the workflow mutex ahead of the strong payment/override row locks.
  -- The override trigger reacquires it reentrantly in this transaction.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_payment
  from public.b2c_payments
  where id = p_payment_id
  for update;
  if not found then
    raise exception 'The B2C payment is unavailable';
  end if;

  select * into prior_override
  from public.b2c_payment_local_overrides
  where payment_id = p_payment_id
  for update;

  effective_customer_name := coalesce(nullif(trim(p_customer_name), ''), prior_override.customer_name, target_payment.customer_name);
  effective_customer_email := coalesce(nullif(lower(trim(p_customer_email)), ''), prior_override.customer_email, target_payment.customer_email);
  effective_customer_phone := coalesce(nullif(trim(p_customer_phone), ''), prior_override.customer_phone, target_payment.customer_phone);
  effective_category_code := coalesce(nullif(lower(trim(p_category_code)), ''), prior_override.category_code, target_payment.category_code);
  effective_membership_tier := coalesce(nullif(trim(p_membership_tier), ''), prior_override.membership_tier, target_payment.membership_tier);
  effective_amount_usd := coalesce(p_local_amount_usd, prior_override.local_amount_usd, target_payment.amount_usd);
  effective_occurred_on := coalesce(p_local_occurred_on, prior_override.local_occurred_on, target_payment.occurred_on);

  if effective_customer_name is not distinct from coalesce(prior_override.customer_name, target_payment.customer_name)
    and effective_customer_email is not distinct from coalesce(prior_override.customer_email, target_payment.customer_email)
    and effective_customer_phone is not distinct from coalesce(prior_override.customer_phone, target_payment.customer_phone)
    and effective_category_code is not distinct from coalesce(prior_override.category_code, target_payment.category_code)
    and effective_membership_tier is not distinct from coalesce(prior_override.membership_tier, target_payment.membership_tier)
    and effective_amount_usd is not distinct from coalesce(prior_override.local_amount_usd, target_payment.amount_usd)
    and effective_occurred_on is not distinct from coalesce(prior_override.local_occurred_on, target_payment.occurred_on) then
    raise exception 'The submitted values do not change this payment';
  end if;

  insert into public.b2c_payment_local_overrides (
    payment_id, customer_name, customer_email, customer_phone, category_code,
    membership_tier, local_amount_usd, local_occurred_on, created_by, updated_by
  ) values (
    p_payment_id,
    case when p_customer_name is null then prior_override.customer_name else effective_customer_name end,
    case when p_customer_email is null then prior_override.customer_email else effective_customer_email end,
    case when p_customer_phone is null then prior_override.customer_phone else effective_customer_phone end,
    case when p_category_code is null then prior_override.category_code else effective_category_code end,
    case when p_membership_tier is null then prior_override.membership_tier else effective_membership_tier end,
    case when p_local_amount_usd is null then prior_override.local_amount_usd else effective_amount_usd end,
    case when p_local_occurred_on is null then prior_override.local_occurred_on else effective_occurred_on end,
    auth.uid(), auth.uid()
  ) on conflict (payment_id) do update set
    customer_name = excluded.customer_name,
    customer_email = excluded.customer_email,
    customer_phone = excluded.customer_phone,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    local_amount_usd = excluded.local_amount_usd,
    local_occurred_on = excluded.local_occurred_on,
    updated_by = auth.uid();

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    jsonb_build_object(
      'customer_name', coalesce(prior_override.customer_name, target_payment.customer_name),
      'customer_email', coalesce(prior_override.customer_email, target_payment.customer_email),
      'customer_phone', coalesce(prior_override.customer_phone, target_payment.customer_phone),
      'category_code', coalesce(prior_override.category_code, target_payment.category_code),
      'membership_tier', coalesce(prior_override.membership_tier, target_payment.membership_tier),
      'amount_usd', coalesce(prior_override.local_amount_usd, target_payment.amount_usd),
      'occurred_on', coalesce(prior_override.local_occurred_on, target_payment.occurred_on)
    ),
    jsonb_build_object(
      'customer_name', effective_customer_name,
      'customer_email', effective_customer_email,
      'customer_phone', effective_customer_phone,
      'category_code', effective_category_code,
      'membership_tier', effective_membership_tier,
      'amount_usd', effective_amount_usd,
      'occurred_on', effective_occurred_on
    ),
    trim(p_reason), effective_occurred_on
  );

  if p_customer_email is not null then
    insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
    select id, 'resolved', trim(p_reason)
    from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and flag_type = 'needs_follow_up'
      and status = 'open'
      and reason ~* 'missing a valid customer email'
    on conflict (flag_id) do nothing;
  end if;

end;
$$;

revoke all on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text) from public;
grant execute on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text) to authenticated;
