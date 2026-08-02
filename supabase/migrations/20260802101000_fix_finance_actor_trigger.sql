-- Fix the shared actor trigger when it is invoked by target/coverage tables that
-- do not expose source_system. Safe to apply to databases that already ran 004.
create or replace function public.assign_finance_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Financial admin entries require an authenticated administrator';
  end if;

  if tg_table_name = 'financial_corrections' then
    new.created_by := auth.uid();
  elsif tg_table_name in ('expenses', 'cash_position_snapshots', 'summit_updates') then
    new.entered_by := auth.uid();
  elsif tg_table_name = 'exchange_rates' then
    if to_jsonb(new) ->> 'source_system' = 'manual_finance' then
      new.entered_by := auth.uid();
    end if;
  elsif tg_table_name in ('financial_targets', 'summit_targets') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    end if;
    new.updated_by := auth.uid();
  elsif tg_table_name = 'data_coverage' then
    new.recorded_by := auth.uid();
  end if;
  return new;
end;
$$;
