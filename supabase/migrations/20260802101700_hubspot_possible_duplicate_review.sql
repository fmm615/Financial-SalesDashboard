alter table public.b2b_deals
  add column duplicate_review_status text not null default 'clear'
    check (duplicate_review_status in ('clear', 'needs_review', 'include', 'exclude'));

create table public.b2b_duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  status text not null default 'open' check (status in ('open', 'resolved')),
  decision text check (decision in ('keep_both', 'keep_one')),
  resolution_note text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check ((status = 'open' and decision is null and resolved_by is null and resolved_at is null)
    or (status = 'resolved' and decision is not null and resolution_note is not null and resolved_by is not null and resolved_at is not null))
);

create table public.b2b_duplicate_group_members (
  group_id uuid not null references public.b2b_duplicate_groups(id),
  deal_id uuid not null unique references public.b2b_deals(id),
  decision text not null default 'pending' check (decision in ('pending', 'include', 'exclude')),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (group_id, deal_id)
);

-- Duplicate candidates are operational review data: only Admins can read it
-- and the only mutation path is the audited resolver below.
alter table public.b2b_duplicate_groups enable row level security;
alter table public.b2b_duplicate_group_members enable row level security;

create policy b2b_duplicate_groups_read_admin
  on public.b2b_duplicate_groups for select to authenticated
  using (public.is_admin());

create policy b2b_duplicate_group_members_read_admin
  on public.b2b_duplicate_group_members for select to authenticated
  using (public.is_admin());

grant select on public.b2b_duplicate_groups, public.b2b_duplicate_group_members to authenticated;

create trigger audit_b2b_duplicate_groups
  after insert or update or delete on public.b2b_duplicate_groups
  for each row execute procedure public.write_audit_event();

create trigger audit_b2b_duplicate_group_members
  after insert or update or delete on public.b2b_duplicate_group_members
  for each row execute procedure public.write_audit_event();

create or replace function public.flag_hubspot_possible_duplicates(p_deal_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare src public.b2b_deals%rowtype; group_key text; v_group_id uuid; v_group_status text;
begin
  select * into src from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and financial_status = 'complete';
  if not found then return; end if;
  group_key := md5(lower(trim(src.name)) || '|' || src.stage_code || '|' || src.pipeline_amount_usd::text || '|' || coalesce(src.hubspot_close_date::text, 'none'));
  if (select count(*) from public.b2b_deals d where d.source_system = 'hubspot' and d.financial_status = 'complete'
      and lower(trim(d.name)) = lower(trim(src.name)) and d.stage_code = src.stage_code
      and d.pipeline_amount_usd = src.pipeline_amount_usd and d.hubspot_close_date is not distinct from src.hubspot_close_date) < 2 then return; end if;
  insert into public.b2b_duplicate_groups (fingerprint) values (group_key) on conflict (fingerprint) do nothing;
  select id, status into v_group_id, v_group_status from public.b2b_duplicate_groups where fingerprint = group_key;
  -- Reconciliation re-upserts the same source deals. A previous Admin decision
  -- must never be silently reopened or overwritten by that normal sync.
  if v_group_status = 'resolved' then return; end if;
  insert into public.b2b_duplicate_group_members (group_id, deal_id)
  select v_group_id, d.id from public.b2b_deals d where d.source_system = 'hubspot' and d.financial_status = 'complete'
    and lower(trim(d.name)) = lower(trim(src.name)) and d.stage_code = src.stage_code
    and d.pipeline_amount_usd = src.pipeline_amount_usd and d.hubspot_close_date is not distinct from src.hubspot_close_date
  on conflict (group_id, deal_id) do nothing;
  update public.b2b_deals set duplicate_review_status = 'needs_review' where id in (select deal_id from public.b2b_duplicate_group_members where group_id = v_group_id);
  insert into public.review_flags (source_area, source_record_id, flag_type, status, priority, reason)
  select 'b2b_deal', deal_id, 'possible_duplicate', 'open', 2, 'Potential duplicate HubSpot deal; Admin must choose whether to include both or keep one.'
  from public.b2b_duplicate_group_members where group_id = v_group_id
  on conflict (source_area, source_record_id, flag_type, status) do nothing;
end; $$;

do $$ declare row_id uuid; begin
  for row_id in select id from public.b2b_deals where source_system = 'hubspot' and financial_status = 'complete' loop
    perform public.flag_hubspot_possible_duplicates(row_id);
  end loop;
end $$;

create or replace function public.resolve_hubspot_duplicate_group(p_group_id uuid, p_decision text, p_keep_deal_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can resolve duplicate candidates'; end if;
  if p_decision not in ('keep_both', 'keep_one') or char_length(trim(p_note)) = 0 then raise exception 'A decision and resolution note are required'; end if;
  if p_decision = 'keep_one' and (p_keep_deal_id is null or not exists (select 1 from public.b2b_duplicate_group_members where group_id = p_group_id and deal_id = p_keep_deal_id)) then raise exception 'Select one deal to keep'; end if;
  update public.b2b_duplicate_group_members set decision = case when p_decision = 'keep_both' or deal_id = p_keep_deal_id then 'include' else 'exclude' end where group_id = p_group_id;
  update public.b2b_deals set duplicate_review_status = case when m.decision = 'exclude' then 'exclude' else 'include' end from public.b2b_duplicate_group_members m where m.group_id = p_group_id and m.deal_id = b2b_deals.id;
  update public.b2b_duplicate_groups set status = 'resolved', decision = p_decision, resolution_note = p_note, resolved_by = auth.uid(), resolved_at = timezone('utc', now()) where id = p_group_id and status = 'open';
  if not found then raise exception 'Duplicate group is already resolved or does not exist'; end if;
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', p_note from public.review_flags where source_area = 'b2b_deal' and source_record_id in (select deal_id from public.b2b_duplicate_group_members where group_id = p_group_id) and flag_type = 'possible_duplicate' and status = 'open'
  on conflict (flag_id) do nothing;
end; $$;

revoke all on function public.flag_hubspot_possible_duplicates(uuid) from public;
revoke all on function public.resolve_hubspot_duplicate_group(uuid, text, uuid, text) from public;
grant execute on function public.resolve_hubspot_duplicate_group(uuid, text, uuid, text) to authenticated;
grant execute on function public.flag_hubspot_possible_duplicates(uuid) to service_role;
