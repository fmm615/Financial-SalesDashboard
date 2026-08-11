-- Operational targets are historical, auditable definitions. Revisions must
-- archive the active target and create its successor in one transaction.
create or replace function public.revise_operational_target(
  p_target_id uuid,
  p_display_name text,
  p_value_kind public.operational_target_value_kind,
  p_target_value numeric,
  p_unit_label text,
  p_period_start date,
  p_period_end date,
  p_finance_reference text,
  p_revision_reason text
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  prior public.operational_targets%rowtype;
  successor_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admin access is required';
  end if;

  select * into prior
    from public.operational_targets
    where id = p_target_id and status = 'active'
    for update;
  if not found then
    raise exception 'Active operational target not found';
  end if;

  if trim(p_display_name) = ''
    or p_period_end < p_period_start
    or p_target_value < 0
    or trim(p_finance_reference) = ''
    or trim(p_revision_reason) = ''
    or (p_value_kind = 'quantity' and trim(coalesce(p_unit_label, '')) = '')
    or (p_value_kind = 'money_usd' and p_unit_label is not null) then
    raise exception 'Invalid operational target revision';
  end if;

  update public.operational_targets
    set status = 'archived', archived_at = timezone('utc', now())
    where id = prior.id;

  insert into public.operational_targets (
    target_lineage_id,
    revision_number,
    display_name,
    value_kind,
    target_value,
    unit_label,
    period_start,
    period_end,
    status,
    finance_reference,
    revision_reason
  ) values (
    prior.target_lineage_id,
    prior.revision_number + 1,
    trim(p_display_name),
    p_value_kind,
    p_target_value,
    case when p_value_kind = 'money_usd' then null else trim(p_unit_label) end,
    p_period_start,
    p_period_end,
    'active',
    trim(p_finance_reference),
    trim(p_revision_reason)
  ) returning id into successor_id;

  return successor_id;
end;
$$;

revoke all on function public.revise_operational_target(uuid, text, public.operational_target_value_kind, numeric, text, date, date, text, text) from public;
grant execute on function public.revise_operational_target(uuid, text, public.operational_target_value_kind, numeric, text, date, date, text, text) to authenticated;
