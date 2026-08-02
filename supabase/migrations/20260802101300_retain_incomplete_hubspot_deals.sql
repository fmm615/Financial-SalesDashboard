-- Preserve incomplete HubSpot deals for traceability without inventing a
-- financial amount. These records cannot create bookings until Finance/Admin
-- supplies a documented correction.
alter table public.b2b_deals
  add column financial_status text not null default 'complete'
    check (financial_status in ('complete', 'needs_review'));

alter table public.b2b_deals
  alter column pipeline_original_amount drop not null,
  alter column exchange_rate_to_usd drop not null,
  alter column pipeline_amount_usd drop not null;

alter table public.b2b_deals
  add constraint b2b_deals_financial_status_values_check
  check (
    (financial_status = 'complete'
      and pipeline_original_amount is not null
      and exchange_rate_to_usd is not null
      and pipeline_amount_usd is not null)
    or
    (financial_status = 'needs_review'
      and pipeline_original_amount is null
      and exchange_rate_to_usd is null
      and pipeline_amount_usd is null)
  );

create or replace function public.prevent_incomplete_deal_booking()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.b2b_deals
    where id = new.deal_id
      and financial_status = 'complete'
  ) then
    raise exception 'A booking cannot be created for a B2B deal with incomplete financial data';
  end if;
  return new;
end;
$$;

create trigger prevent_incomplete_b2b_deal_booking
  before insert or update of deal_id on public.b2b_bookings
  for each row execute procedure public.prevent_incomplete_deal_booking();

create unique index review_flags_one_status_per_b2b_deal
  on public.review_flags (source_area, source_record_id, flag_type, status);
