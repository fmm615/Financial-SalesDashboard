-- Keep the stored reporting amount derived from the retained source amount and
-- FX rate. This prevents API or direct SQL clients from recording inconsistent
-- original and USD recognised-sale values.
create or replace function public.validate_recognised_sale()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  booking_deal_id uuid;
  deal_amount_usd numeric(20, 6);
  recognised_total_usd numeric(20, 6);
begin
  if auth.uid() is null then
    raise exception 'Recognised sales require an authenticated administrator';
  end if;
  new.entered_by := auth.uid();
  new.entered_at := timezone('utc', now());

  if new.original_currency = 'USD' and new.exchange_rate_to_usd <> 1 then
    raise exception 'USD recognised sales require an exchange rate of 1';
  end if;

  new.recognised_amount_usd := round(new.recognised_amount * new.exchange_rate_to_usd, 6);

  if new.booking_id is not null then
    select deal_id into booking_deal_id from public.b2b_bookings where id = new.booking_id;
    if booking_deal_id is distinct from new.deal_id then
      raise exception 'Recognised sale booking must belong to the linked deal';
    end if;
  end if;

  select pipeline_amount_usd into deal_amount_usd
  from public.b2b_deals
  where id = new.deal_id
  for update;

  if deal_amount_usd is null then
    raise exception 'Recognised sale requires a linked deal with a known USD amount';
  end if;

  select coalesce(sum(recognised_amount_usd), 0) into recognised_total_usd
  from public.b2b_recognised_sales
  where deal_id = new.deal_id;

  if recognised_total_usd + new.recognised_amount_usd > deal_amount_usd then
    raise exception 'Recognised sales cannot exceed the linked deal USD amount';
  end if;

  return new;
end;
$$;
