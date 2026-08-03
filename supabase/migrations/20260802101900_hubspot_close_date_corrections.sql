-- A HubSpot closed-won deal may have valid money but no close date. Retain it
-- locally for traceability and let an Admin add an audited local date; this
-- never mutates HubSpot.
create or replace function public.apply_hubspot_deal_close_date_correction(
  p_deal_id uuid,
  p_close_date date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_deal public.b2b_deals%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can correct a HubSpot close date';
  end if;

  if p_close_date is null or char_length(trim(p_reason)) = 0 then
    raise exception 'A close date and correction reason are required';
  end if;

  select * into target_deal
  from public.b2b_deals
  where id = p_deal_id
    and source_system = 'hubspot'
    and stage_code = 'closed_won'
    and financial_status = 'complete'
    and hubspot_close_date is null
  for update;

  if not found then
    raise exception 'The HubSpot deal is not awaiting a close-date correction';
  end if;

  update public.b2b_deals
  set hubspot_close_date = p_close_date,
      source_metadata = target_deal.source_metadata || jsonb_build_object(
        'local_close_date_correction_at', timezone('utc', now())::text,
        'local_close_date_correction_by', auth.uid()::text,
        'local_close_date_correction_reason', p_reason
      )
  where id = p_deal_id;

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2b_deal',
    p_deal_id,
    'date',
    jsonb_build_object('hubspot_close_date', target_deal.hubspot_close_date),
    jsonb_build_object('hubspot_close_date', p_close_date),
    p_reason,
    p_close_date
  );

  insert into public.b2b_bookings (
    deal_id, source_system, booking_date, original_amount, original_currency,
    exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason
  ) values (
    p_deal_id, 'manual_finance', p_close_date, target_deal.pipeline_original_amount,
    target_deal.original_currency, target_deal.exchange_rate_to_usd,
    target_deal.pipeline_amount_usd, format('HubSpot deal %s', target_deal.external_deal_id), p_reason
  ) on conflict (deal_id) do nothing;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', p_reason
  from public.review_flags
  where source_area = 'b2b_deal'
    and source_record_id = p_deal_id
    and flag_type = 'needs_follow_up'
    and status = 'open'
  on conflict (flag_id) do nothing;
end;
$$;

revoke all on function public.apply_hubspot_deal_close_date_correction(uuid, date, text) from public;
grant execute on function public.apply_hubspot_deal_close_date_correction(uuid, date, text) to authenticated;
