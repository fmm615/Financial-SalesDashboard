create or replace function public.revise_financial_target(
  p_target_id uuid,
  p_metric_code text,
  p_period_start date,
  p_period_end date,
  p_target_amount_usd numeric,
  p_finance_reference text,
  p_revision_reason text
) returns uuid
language plpgsql
set search_path = public
as $$
declare prior public.financial_targets%rowtype; successor_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin access is required'; end if;
  select * into prior from public.financial_targets where id = p_target_id and status = 'active' for update;
  if not found then raise exception 'Active financial target not found'; end if;
  if p_period_end < p_period_start or p_target_amount_usd < 0 or trim(p_finance_reference) = '' or trim(p_revision_reason) = '' then raise exception 'Invalid target revision'; end if;
  update public.financial_targets set status = 'archived', archived_at = timezone('utc', now()) where id = prior.id;
  insert into public.financial_targets (target_lineage_id, revision_number, metric_code, period_start, period_end, target_amount_usd, status, finance_reference, revision_reason)
    values (prior.target_lineage_id, prior.revision_number + 1, p_metric_code, p_period_start, p_period_end, p_target_amount_usd, 'active', trim(p_finance_reference), trim(p_revision_reason))
    returning id into successor_id;
  return successor_id;
end;
$$;
revoke all on function public.revise_financial_target(uuid, text, date, date, numeric, text, text) from public;
grant execute on function public.revise_financial_target(uuid, text, date, date, numeric, text, text) to authenticated;

