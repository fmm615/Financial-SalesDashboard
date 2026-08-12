-- The Finance Payment Tracker tabs do not share equivalent category or contact
-- fields. Cross-tab duplicate candidates therefore use only their proven
-- shared fields and remain subject to explicit Admin review.

create or replace function public.create_b2c_exact_duplicate_groups()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  created_count integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can group exact B2C Finance duplicates';
  end if;

  perform pg_advisory_xact_lock(hashtext('b2c_exact_duplicate_grouping'));

  with eligible_rows as (
    select
      rows.id,
      rows.import_id,
      rows.source_tab,
      rows.occurred_on,
      rows.amount_usd,
      lower(trim(rows.payment_method_raw)) as payment_method_key,
      rows.normalized_customer_name as customer_name_key
    from public.b2c_finance_staging_rows rows
    join public.b2c_finance_imports imports on imports.id = rows.import_id
    where imports.source_kind = 'payment_tracker'
      and imports.import_status = 'completed'
      and rows.row_quality = 'valid'
      and rows.occurred_on is not null
      and rows.amount_usd is not null
      and rows.normalized_customer_name is not null
      and nullif(trim(rows.payment_method_raw), '') is not null
      and not exists (
        select 1
        from public.b2c_reconciliation_finance_rows existing_links
        where existing_links.finance_row_id = rows.id
      )
  ), exact_pair_keys as (
    select
      import_id,
      occurred_on,
      amount_usd,
      payment_method_key,
      customer_name_key,
      (array_agg(id order by id) filter (where source_tab = 'B2C'))[1] as b2c_row_id,
      (array_agg(id order by id) filter (where source_tab = 'B2C Cons'))[1] as b2c_cons_row_id
    from eligible_rows
    group by import_id, occurred_on, amount_usd, payment_method_key, customer_name_key
    having count(*) filter (where source_tab = 'B2C') = 1
      and count(*) filter (where source_tab = 'B2C Cons') = 1
      and count(*) = 2
  ), candidates as (
    select
      b2c_row_id,
      b2c_cons_row_id,
      'exact-finance:' || least(b2c_row_id::text, b2c_cons_row_id::text) || ':' || greatest(b2c_row_id::text, b2c_cons_row_id::text) as grouping_key
    from exact_pair_keys
  ), inserted_groups as (
    insert into public.b2c_reconciliation_groups (reconciliation_state, grouping_key)
    select 'exact_duplicate_candidate', grouping_key
    from candidates
    on conflict (grouping_key) where grouping_key is not null do nothing
    returning id, grouping_key
  ), inserted_links as (
    insert into public.b2c_reconciliation_finance_rows (reconciliation_group_id, finance_row_id)
    select inserted_groups.id, candidate_rows.finance_row_id
    from inserted_groups
    join candidates on candidates.grouping_key = inserted_groups.grouping_key
    cross join lateral (values (candidates.b2c_row_id), (candidates.b2c_cons_row_id)) as candidate_rows(finance_row_id)
    on conflict (finance_row_id) do nothing
  )
  select count(*) into created_count from inserted_groups;

  return created_count;
end;
$$;

revoke all on function public.create_b2c_exact_duplicate_groups() from public;
grant execute on function public.create_b2c_exact_duplicate_groups() to authenticated;
