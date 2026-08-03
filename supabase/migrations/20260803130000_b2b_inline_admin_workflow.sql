-- Imported HubSpot deals are retained locally. An Admin may either apply an
-- auditable local override or exclude a source record from PLAYBOOK views;
-- neither action writes to HubSpot or deletes source traceability.
alter table public.b2b_deals
  add column local_record_status text not null default 'active'
    check (local_record_status in ('active', 'excluded'));

create index b2b_deals_local_record_status_idx
  on public.b2b_deals (local_record_status);

create or replace view public.reportable_b2b_deals
with (security_invoker = true)
as
select d.*
from public.b2b_deals d
where d.local_record_status = 'active'
  and d.financial_status = 'complete'
  and d.duplicate_review_status in ('clear', 'include')
  and (d.stage_code <> 'closed_won' or d.hubspot_close_date is not null);

revoke all on public.reportable_b2b_deals from public;
grant select on public.reportable_b2b_deals to authenticated;

-- HubSpot remains the source, but a documented local Admin override must stay
-- effective until Finance changes it again. A later read-only HubSpot pull may
-- refresh source metadata and import timestamps, but cannot silently undo the
-- locally audited operational values.
create or replace function public.preserve_local_hubspot_close_date_correction()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.source_system = 'hubspot' and old.source_metadata ? 'local_override_at' then
    new.name := old.name;
    new.owner_name := old.owner_name;
    new.stage_code := old.stage_code;
    new.financial_status := old.financial_status;
    new.pipeline_original_amount := old.pipeline_original_amount;
    new.original_currency := old.original_currency;
    new.exchange_rate_to_usd := old.exchange_rate_to_usd;
    new.pipeline_amount_usd := old.pipeline_amount_usd;
    new.hubspot_close_date := old.hubspot_close_date;
    new.renewal_date := old.renewal_date;
    new.source_metadata := new.source_metadata || jsonb_build_object(
      'local_override_at', old.source_metadata->'local_override_at',
      'local_override_by', old.source_metadata->'local_override_by',
      'local_override_reason', old.source_metadata->'local_override_reason'
    );
  elsif old.source_system = 'hubspot'
    and old.source_metadata ? 'local_close_date_correction_at'
    and new.hubspot_close_date is null then
    new.hubspot_close_date := old.hubspot_close_date;
    new.source_metadata := new.source_metadata || jsonb_build_object(
      'local_close_date_correction_at', old.source_metadata->'local_close_date_correction_at',
      'local_close_date_correction_by', old.source_metadata->'local_close_date_correction_by',
      'local_close_date_correction_reason', old.source_metadata->'local_close_date_correction_reason'
    );
  end if;
  return new;
end;
$$;

create or replace function public.apply_hubspot_deal_local_override(
  p_deal_id uuid,
  p_name text,
  p_owner_name text,
  p_stage_code text,
  p_amount numeric(20, 6),
  p_currency char(3),
  p_exchange_rate_to_usd numeric(20, 10),
  p_close_date date,
  p_renewal_date date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_deal public.b2b_deals%rowtype;
  next_financial_status text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can update a HubSpot deal locally';
  end if;
  if char_length(trim(p_name)) = 0 or char_length(trim(p_stage_code)) = 0 or char_length(trim(p_reason)) = 0 then
    raise exception 'Deal name, stage, and audit reason are required';
  end if;
  if not exists (select 1 from public.b2b_deal_stages where code = p_stage_code) then
    raise exception 'Use an approved PLAYBOOK B2B stage';
  end if;
  if (p_amount is null) <> (p_currency is null) or (p_amount is null) <> (p_exchange_rate_to_usd is null) then
    raise exception 'Amount, currency, and exchange rate must be supplied together or all left unavailable';
  end if;
  if p_amount is not null and (p_amount < 0 or p_exchange_rate_to_usd <= 0) then
    raise exception 'Amount must be non-negative and exchange rate must be above zero';
  end if;

  select * into target_deal
  from public.b2b_deals
  where id = p_deal_id
    and source_system = 'hubspot'
    and local_record_status = 'active'
  for update;
  if not found then
    raise exception 'The HubSpot deal is unavailable for local editing';
  end if;

  if target_deal.stage_code = 'closed_won' and p_stage_code <> 'closed_won'
    and exists (select 1 from public.b2b_bookings where deal_id = p_deal_id) then
    raise exception 'A booked deal cannot be moved out of closed-won. Exclude it locally instead of rewriting booking history';
  end if;

  next_financial_status := case when p_amount is null then 'needs_review' else 'complete' end;
  update public.b2b_deals
  set name = trim(p_name),
      owner_name = nullif(trim(p_owner_name), ''),
      stage_code = p_stage_code,
      financial_status = next_financial_status,
      pipeline_original_amount = p_amount,
      original_currency = p_currency,
      exchange_rate_to_usd = p_exchange_rate_to_usd,
      pipeline_amount_usd = case when p_amount is null then null else p_amount * p_exchange_rate_to_usd end,
      hubspot_close_date = p_close_date,
      renewal_date = p_renewal_date,
      source_metadata = target_deal.source_metadata || jsonb_build_object(
        'local_override_at', timezone('utc', now())::text,
        'local_override_by', auth.uid()::text,
        'local_override_reason', p_reason
      )
  where id = p_deal_id;

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2b_deal', p_deal_id, 'other',
    jsonb_build_object('name', target_deal.name, 'owner_name', target_deal.owner_name, 'stage_code', target_deal.stage_code, 'pipeline_original_amount', target_deal.pipeline_original_amount, 'original_currency', target_deal.original_currency, 'exchange_rate_to_usd', target_deal.exchange_rate_to_usd, 'hubspot_close_date', target_deal.hubspot_close_date, 'renewal_date', target_deal.renewal_date),
    jsonb_build_object('name', trim(p_name), 'owner_name', nullif(trim(p_owner_name), ''), 'stage_code', p_stage_code, 'pipeline_original_amount', p_amount, 'original_currency', p_currency, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'hubspot_close_date', p_close_date, 'renewal_date', p_renewal_date),
    p_reason, coalesce(p_close_date, current_date)
  );

  if p_stage_code = 'closed_won' and p_amount is not null and p_close_date is not null then
    insert into public.b2b_bookings (
      deal_id, source_system, booking_date, original_amount, original_currency,
      exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason
    ) values (
      p_deal_id, 'manual_finance', p_close_date, p_amount, p_currency,
      p_exchange_rate_to_usd, p_amount * p_exchange_rate_to_usd,
      format('HubSpot deal %s', target_deal.external_deal_id), p_reason
    ) on conflict (deal_id) do update set
      source_system = excluded.source_system,
      booking_date = excluded.booking_date,
      original_amount = excluded.original_amount,
      original_currency = excluded.original_currency,
      exchange_rate_to_usd = excluded.exchange_rate_to_usd,
      booking_amount_usd = excluded.booking_amount_usd,
      source_reference = excluded.source_reference,
      manual_entry_reason = excluded.manual_entry_reason;
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', p_reason
  from public.review_flags
  where source_area = 'b2b_deal'
    and source_record_id = p_deal_id
    and status = 'open'
  on conflict (flag_id) do nothing;

  -- The corresponding per-deal technical tickets are now explained by this
  -- audited local correction. This does not edit the source in HubSpot.
  update public.integration_errors
  set resolved_at = timezone('utc', now()),
      resolved_by = auth.uid(),
      resolution_note = p_reason
  where provider = 'hubspot'
    and resolved_at is null
    and source_reference like format('HubSpot deal %s —%%', target_deal.external_deal_id);
end;
$$;

create or replace function public.exclude_hubspot_deal_locally(p_deal_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare target_deal public.b2b_deals%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can exclude a HubSpot deal locally';
  end if;
  if char_length(trim(p_reason)) = 0 then
    raise exception 'An exclusion reason is required';
  end if;
  select * into target_deal from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and local_record_status = 'active' for update;
  if not found then raise exception 'The HubSpot deal is already excluded or unavailable'; end if;

  update public.b2b_deals
  set local_record_status = 'excluded',
      source_metadata = target_deal.source_metadata || jsonb_build_object('local_exclusion_at', timezone('utc', now())::text, 'local_exclusion_by', auth.uid()::text, 'local_exclusion_reason', p_reason)
  where id = p_deal_id;

  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
  values ('b2b_deal', p_deal_id, 'classification', jsonb_build_object('local_record_status', 'active'), jsonb_build_object('local_record_status', 'excluded'), p_reason, current_date);

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'dismissed', p_reason from public.review_flags
  where source_area = 'b2b_deal' and source_record_id = p_deal_id and status = 'open'
  on conflict (flag_id) do nothing;

  update public.integration_errors
  set resolved_at = timezone('utc', now()),
      resolved_by = auth.uid(),
      resolution_note = p_reason
  where provider = 'hubspot'
    and resolved_at is null
    and source_reference like format('HubSpot deal %s —%%', target_deal.external_deal_id);
end;
$$;

revoke all on function public.apply_hubspot_deal_local_override(uuid, text, text, text, numeric, char, numeric, date, date, text) from public;
revoke all on function public.exclude_hubspot_deal_locally(uuid, text) from public;
grant execute on function public.apply_hubspot_deal_local_override(uuid, text, text, text, numeric, char, numeric, date, date, text) to authenticated;
grant execute on function public.exclude_hubspot_deal_locally(uuid, text) to authenticated;
