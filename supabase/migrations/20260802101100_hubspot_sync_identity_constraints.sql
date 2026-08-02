-- HubSpot imports must be idempotent under webhook retries and reconciliation.
-- These constraints preserve the existing non-null uniqueness semantics while
-- allowing PostgREST upserts to target the provider identity columns directly.
drop index if exists public.b2b_companies_external_id_unique;
alter table public.b2b_companies
  add constraint b2b_companies_source_external_company_unique
  unique (source_system, external_company_id);

drop index if exists public.b2b_deals_external_id_unique;
alter table public.b2b_deals
  add constraint b2b_deals_source_external_deal_unique
  unique (source_system, external_deal_id);
