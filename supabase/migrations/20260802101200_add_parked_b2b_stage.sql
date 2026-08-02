-- Preserve HubSpot's open PARKED stage explicitly instead of misclassifying it
-- as active discovery/qualification pipeline or silently dropping it.
insert into public.b2b_deal_stages (code, label, display_order, is_closed, is_won)
values ('parked', 'Parked', 50, false, false)
on conflict (code) do nothing;
