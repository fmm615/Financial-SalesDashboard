-- A single safe source for dashboard/report queries. Retained source records
-- awaiting correction or duplicate review must never appear in B2B totals.
create or replace view public.reportable_b2b_deals
with (security_invoker = true)
as
select d.*
from public.b2b_deals d
where d.financial_status = 'complete'
  and d.duplicate_review_status in ('clear', 'include')
  and (d.stage_code <> 'closed_won' or d.hubspot_close_date is not null);

revoke all on public.reportable_b2b_deals from public;
grant select on public.reportable_b2b_deals to authenticated;

comment on view public.reportable_b2b_deals is
  'B2B deals safe for dashboards and reports. Excludes incomplete, unresolved duplicate, and closed-won deals without a known close date.';
