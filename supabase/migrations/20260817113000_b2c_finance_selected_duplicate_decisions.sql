-- Allows Finance to choose the retained row for each reviewed exact duplicate
-- pair in one atomic, audited request. It never changes workbook evidence.

create or replace function public.apply_b2c_finance_selected_duplicate_decisions(
  p_decisions jsonb,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_decision jsonb;
  selected_group_id uuid;
  selected_finance_row_id uuid;
  group_state public.b2c_reconciliation_state;
  member_count integer;
  decided_groups integer := 0;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can decide B2C Finance duplicate groups';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A B2C Finance duplicate decision reason must be between 3 and 1000 characters';
  end if;
  if jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) not between 1 and 200 then
    raise exception 'Select between one and 200 B2C Finance duplicate pairs';
  end if;
  if (select count(*) from jsonb_array_elements(p_decisions)) <> (
    select count(distinct value ->> 'groupId') from jsonb_array_elements(p_decisions)
  ) then
    raise exception 'Select each B2C Finance duplicate pair only once';
  end if;

  for selected_decision in select value from jsonb_array_elements(p_decisions) loop
    if jsonb_typeof(selected_decision) <> 'object'
      or coalesce(selected_decision ->> 'groupId', '') !~* uuid_pattern
      or coalesce(selected_decision ->> 'financeRowId', '') !~* uuid_pattern then
      raise exception 'Every B2C Finance duplicate decision must include valid group and Finance row IDs';
    end if;

    selected_group_id := (selected_decision ->> 'groupId')::uuid;
    selected_finance_row_id := (selected_decision ->> 'financeRowId')::uuid;

    select groups.reconciliation_state into group_state
    from public.b2c_reconciliation_groups groups
    where groups.id = selected_group_id
    for update;

    if not found or group_state <> 'exact_duplicate_candidate' then
      raise exception 'Every selected group must be an unresolved exact B2C Finance duplicate';
    end if;

    select count(*) into member_count
    from public.b2c_reconciliation_finance_rows group_rows
    join public.b2c_finance_staging_rows rows on rows.id = group_rows.finance_row_id
    where group_rows.reconciliation_group_id = selected_group_id
      and rows.source_tab in ('B2C', 'B2C Cons');

    if member_count <> 2 then
      raise exception 'Every selected group must contain exactly one B2C row and one B2C Cons row';
    end if;

    if not exists (
      select 1
      from public.b2c_reconciliation_finance_rows group_rows
      where group_rows.reconciliation_group_id = selected_group_id
        and group_rows.finance_row_id = selected_finance_row_id
    ) then
      raise exception 'The selected Finance row must belong to the duplicate group';
    end if;

    insert into public.b2c_reconciliation_decisions (
      reconciliation_group_id, decision_state, canonical_finance_row_id, decision_reason
    ) values (
      selected_group_id, 'canonical', selected_finance_row_id, trim(p_reason)
    );
    decided_groups := decided_groups + 1;
  end loop;

  return decided_groups;
end;
$$;

revoke all on function public.apply_b2c_finance_selected_duplicate_decisions(jsonb, text) from public;
grant execute on function public.apply_b2c_finance_selected_duplicate_decisions(jsonb, text) to authenticated;
