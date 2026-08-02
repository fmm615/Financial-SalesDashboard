-- A HubSpot deal without a currency is an incomplete source record, not a
-- zero-dollar deal. Only complete records may carry monetary values.
alter table public.b2b_deals
  alter column original_currency drop not null;

alter table public.b2b_deals
  drop constraint b2b_deals_financial_status_values_check,
  add constraint b2b_deals_financial_status_values_check
  check (
    (financial_status = 'complete'
      and pipeline_original_amount is not null
      and original_currency is not null
      and exchange_rate_to_usd is not null
      and pipeline_amount_usd is not null)
    or
    (financial_status = 'needs_review'
      and pipeline_original_amount is null
      and exchange_rate_to_usd is null
      and pipeline_amount_usd is null)
  );
