-- Finance-approved manual B2B entry is a local, audited fallback. It does not
-- call HubSpot, create receipts, or create recognised sales.
create or replace function public.flag_manual_b2b_possible_duplicates(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  src public.b2b_deals%rowtype;
  group_key text;
  v_group_id uuid;
  v_group_status text;
begin
  select * into src
  from public.b2b_deals
  where id = p_deal_id
    and source_system = 'manual_finance'
    and local_record_status = 'active'
    and financial_status = 'complete';
  if not found then return; end if;

  -- Manual entries have no provider identifier. Exact same name, stage, amount,
  -- and close date are therefore candidates for an Admin decision, not a silent
  -- deduplication. The manual prefix keeps an already resolved HubSpot group
  -- immutable if a later manual entry happens to have matching values.
  group_key := md5('manual_finance|' || lower(trim(src.name)) || '|' || src.stage_code || '|' || src.pipeline_amount_usd::text || '|' || coalesce(src.hubspot_close_date::text, 'none'));
  if (
    select count(*)
    from public.b2b_deals d
    where d.source_system = 'manual_finance'
      and d.local_record_status = 'active'
      and d.financial_status = 'complete'
      and lower(trim(d.name)) = lower(trim(src.name))
      and d.stage_code = src.stage_code
      and d.pipeline_amount_usd = src.pipeline_amount_usd
      and d.hubspot_close_date is not distinct from src.hubspot_close_date
  ) < 2 then return; end if;

  insert into public.b2b_duplicate_groups (fingerprint)
  values (group_key)
  on conflict (fingerprint) do nothing;

  select id, status into v_group_id, v_group_status
  from public.b2b_duplicate_groups
  where fingerprint = group_key;
  if v_group_status = 'resolved' then return; end if;

  insert into public.b2b_duplicate_group_members (group_id, deal_id)
  select v_group_id, d.id
  from public.b2b_deals d
  where d.source_system = 'manual_finance'
    and d.local_record_status = 'active'
    and d.financial_status = 'complete'
    and lower(trim(d.name)) = lower(trim(src.name))
    and d.stage_code = src.stage_code
    and d.pipeline_amount_usd = src.pipeline_amount_usd
    and d.hubspot_close_date is not distinct from src.hubspot_close_date
  on conflict (group_id, deal_id) do nothing;

  update public.b2b_deals
  set duplicate_review_status = 'needs_review'
  where id in (
    select deal_id from public.b2b_duplicate_group_members where group_id = v_group_id
  );

  insert into public.review_flags (source_area, source_record_id, flag_type, status, priority, reason)
  select 'b2b_deal', deal_id, 'possible_duplicate', 'open', 2,
    'Potential duplicate manual B2B deal; Admin must choose whether to include both or keep one.'
  from public.b2b_duplicate_group_members
  where group_id = v_group_id
  on conflict (source_area, source_record_id, flag_type, status) do nothing;
end;
$$;

create or replace function public.create_manual_b2b_deal(
  p_company_name text,
  p_name text,
  p_owner_name text,
  p_stage_code text,
  p_original_amount numeric(20, 6),
  p_original_currency char(3),
  p_exchange_rate_to_usd numeric(20, 10),
  p_close_date date,
  p_renewal_date date,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_deal_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can create a manual B2B deal';
  end if;
  if char_length(trim(p_company_name)) = 0 or char_length(trim(p_name)) = 0 or char_length(trim(p_reason)) = 0 then
    raise exception 'Company, deal name, and entry reason are required';
  end if;
  if not exists (select 1 from public.b2b_deal_stages where code = p_stage_code) then
    raise exception 'Use an approved PLAYBOOK B2B stage';
  end if;
  if p_original_amount is null or p_original_amount < 0 or p_exchange_rate_to_usd is null or p_exchange_rate_to_usd <= 0 then
    raise exception 'Original amount must be non-negative and exchange rate must be above zero';
  end if;
  if p_original_currency is null or p_original_currency !~ '^[A-Z]{3}$' then
    raise exception 'Use an uppercase ISO currency code';
  end if;
  if p_stage_code = 'closed_won' and p_close_date is null then
    raise exception 'Closed-won deals require a close date before a booking can be recorded';
  end if;

  select id into v_company_id
  from public.b2b_companies
  where source_system = 'manual_finance'
    and lower(trim(legal_name)) = lower(trim(p_company_name))
  order by created_at
  limit 1;

  if v_company_id is null then
    insert into public.b2b_companies (source_system, legal_name)
    values ('manual_finance', trim(p_company_name))
    returning id into v_company_id;
  end if;

  insert into public.b2b_deals (
    company_id, source_system, name, stage_code, financial_status,
    pipeline_original_amount, original_currency, exchange_rate_to_usd,
    pipeline_amount_usd, hubspot_close_date, renewal_date, owner_name,
    manual_entry_reason, source_metadata
  ) values (
    v_company_id, 'manual_finance', trim(p_name), p_stage_code, 'complete',
    p_original_amount, p_original_currency, p_exchange_rate_to_usd,
    p_original_amount * p_exchange_rate_to_usd, p_close_date, p_renewal_date,
    nullif(trim(p_owner_name), ''), trim(p_reason),
    jsonb_build_object('entry_mode', 'manual_finance', 'manual_entry_at', timezone('utc', now())::text, 'manual_entry_by', auth.uid()::text)
  ) returning id into v_deal_id;

  insert into public.b2b_deal_stage_history (deal_id, stage_code, changed_at, source_system)
  values (v_deal_id, p_stage_code, timezone('utc', now()), 'manual_finance');

  if p_stage_code = 'closed_won' then
    insert into public.b2b_bookings (
      deal_id, source_system, booking_date, original_amount, original_currency,
      exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason
    ) values (
      v_deal_id, 'manual_finance', p_close_date, p_original_amount, p_original_currency,
      p_exchange_rate_to_usd, p_original_amount * p_exchange_rate_to_usd,
      format('Manual Finance deal %s', v_deal_id), trim(p_reason)
    );
  end if;

  perform public.flag_manual_b2b_possible_duplicates(v_deal_id);
  return v_deal_id;
end;
$$;

revoke all on function public.flag_manual_b2b_possible_duplicates(uuid) from public;
revoke all on function public.create_manual_b2b_deal(text, text, text, text, numeric, char, numeric, date, date, text) from public;
grant execute on function public.create_manual_b2b_deal(text, text, text, text, numeric, char, numeric, date, date, text) to authenticated;

comment on function public.create_manual_b2b_deal(text, text, text, text, numeric, char, numeric, date, date, text) is
  'Admin-only local Finance B2B entry. Creates a separate booking only for a closed-won deal with a close date; never creates receipts or recognised sales and never writes to HubSpot.';
