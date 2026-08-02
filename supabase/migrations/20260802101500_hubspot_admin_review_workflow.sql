-- Admin corrections supplement incomplete HubSpot source records locally. They
-- never call or mutate HubSpot, and every change keeps an individual actor.
alter table public.financial_corrections
  drop constraint financial_corrections_target_area_check,
  add constraint financial_corrections_target_area_check
  check (target_area in ('b2c_payment', 'b2b_deal', 'b2b_booking', 'b2b_recognised_sale', 'expense'));

create or replace function public.assign_financial_correction_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Financial corrections require an authenticated administrator';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

create trigger assign_financial_correction_actor
  before insert on public.financial_corrections
  for each row execute procedure public.assign_financial_correction_actor();

alter table public.integration_errors
  add column resolution_note text;

-- Preserve any resolution made before this workflow existed while requiring a
-- meaningful note for all later Admin resolutions.
update public.integration_errors
set resolution_note = 'Resolved before the documented HubSpot review workflow was enabled.'
where resolved_at is not null
  and resolution_note is null;

alter table public.integration_errors
  add constraint integration_errors_resolution_check
  check (
    (resolved_at is null and resolved_by is null and resolution_note is null)
    or
    (resolved_at is not null and resolved_by is not null and char_length(trim(resolution_note)) > 0)
  );

create or replace function public.assign_integration_error_resolver()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.resolved_at is not null and old.resolved_at is null then
    if auth.uid() is null then
      raise exception 'Integration error resolution requires an authenticated administrator';
    end if;
    new.resolved_by := auth.uid();
    new.resolved_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create trigger assign_integration_error_resolver
  before update on public.integration_errors
  for each row execute procedure public.assign_integration_error_resolver();

create or replace function public.apply_hubspot_deal_financial_correction(
  p_deal_id uuid,
  p_amount numeric(20, 6),
  p_currency char(3),
  p_exchange_rate_to_usd numeric(20, 10),
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_deal public.b2b_deals%rowtype;
  deal_is_won boolean;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can correct HubSpot financial data';
  end if;

  if p_amount < 0 or p_exchange_rate_to_usd <= 0 or char_length(trim(p_reason)) = 0 then
    raise exception 'Correction amount, exchange rate, and reason are required';
  end if;

  select * into target_deal
  from public.b2b_deals
  where id = p_deal_id
    and source_system = 'hubspot'
    and financial_status = 'needs_review'
  for update;

  if not found then
    raise exception 'The HubSpot deal is not an incomplete record awaiting correction';
  end if;

  update public.b2b_deals
  set financial_status = 'complete',
      pipeline_original_amount = p_amount,
      original_currency = p_currency,
      exchange_rate_to_usd = p_exchange_rate_to_usd,
      pipeline_amount_usd = p_amount * p_exchange_rate_to_usd,
      source_metadata = target_deal.source_metadata || jsonb_build_object(
        'local_financial_correction_at', timezone('utc', now())::text,
        'local_financial_correction_by', auth.uid()::text,
        'local_financial_correction_reason', p_reason
      )
  where id = p_deal_id;

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2b_deal',
    p_deal_id,
    'amount',
    jsonb_build_object(
      'pipeline_original_amount', target_deal.pipeline_original_amount,
      'original_currency', target_deal.original_currency,
      'exchange_rate_to_usd', target_deal.exchange_rate_to_usd,
      'pipeline_amount_usd', target_deal.pipeline_amount_usd
    ),
    jsonb_build_object(
      'pipeline_original_amount', p_amount,
      'original_currency', p_currency,
      'exchange_rate_to_usd', p_exchange_rate_to_usd,
      'pipeline_amount_usd', p_amount * p_exchange_rate_to_usd
    ),
    p_reason,
    coalesce(target_deal.hubspot_close_date, current_date)
  );

  select is_won into deal_is_won
  from public.b2b_deal_stages
  where code = target_deal.stage_code;

  if deal_is_won and target_deal.hubspot_close_date is not null then
    insert into public.b2b_bookings (
      deal_id, source_system, booking_date, original_amount, original_currency,
      exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason
    ) values (
      p_deal_id, 'manual_finance', target_deal.hubspot_close_date, p_amount, p_currency,
      p_exchange_rate_to_usd, p_amount * p_exchange_rate_to_usd,
      format('HubSpot deal %s', target_deal.external_deal_id), p_reason
    ) on conflict (deal_id) do nothing;
  end if;

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

create or replace function public.resolve_hubspot_integration_error(
  p_error_id uuid,
  p_resolution_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can resolve HubSpot integration errors';
  end if;

  if char_length(trim(p_resolution_note)) = 0 then
    raise exception 'A resolution note is required';
  end if;

  update public.integration_errors
  set resolved_at = timezone('utc', now()),
      resolution_note = p_resolution_note
  where id = p_error_id
    and provider = 'hubspot'
    and resolved_at is null;

  if not found then
    raise exception 'HubSpot integration error is already resolved or does not exist';
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', p_resolution_note
  from public.review_flags
  where source_area = 'integration'
    and source_record_id = p_error_id
    and flag_type = 'needs_follow_up'
    and status = 'open'
  on conflict (flag_id) do nothing;
end;
$$;

-- Existing unresolved integration errors become visible in the Admin review
-- workflow immediately after this migration.
insert into public.review_flags (source_area, source_record_id, flag_type, status, priority, reason)
select
  'integration',
  errors.id,
  'needs_follow_up',
  'open',
  2,
  errors.safe_error_summary
from public.integration_errors as errors
where errors.provider = 'hubspot'
  and errors.resolved_at is null
on conflict (source_area, source_record_id, flag_type, status) do nothing;

revoke all on function public.assign_financial_correction_actor() from public;
revoke all on function public.assign_integration_error_resolver() from public;
revoke all on function public.apply_hubspot_deal_financial_correction(uuid, numeric, char, numeric, text) from public;
revoke all on function public.resolve_hubspot_integration_error(uuid, text) from public;
grant execute on function public.apply_hubspot_deal_financial_correction(uuid, numeric, char, numeric, text) to authenticated;
grant execute on function public.resolve_hubspot_integration_error(uuid, text) to authenticated;
