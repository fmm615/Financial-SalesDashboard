-- Clean-slate B2B Operations schema. This migration intentionally creates the
-- final state directly; it does not replay prior B2B schema history.

create table public.b2b_deal_stages (
  code text primary key check (code ~ '^[a-z0-9][a-z0-9_-]*$'),
  label text not null,
  display_order integer not null unique check (display_order >= 0),
  is_closed boolean not null default false,
  is_won boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (not is_won or is_closed)
);

insert into public.b2b_deal_stages (code, label, display_order, is_closed, is_won)
values
  ('discovery', 'Discovery', 10, false, false),
  ('qualified', 'Qualified', 20, false, false),
  ('proposal', 'Proposal', 30, false, false),
  ('negotiation', 'Negotiation', 40, false, false),
  ('parked', 'Parked', 50, false, false),
  ('closed_won', 'Closed won', 90, true, true),
  ('closed_lost', 'Closed lost', 100, true, false);

create table public.b2b_companies (
  id uuid primary key default gen_random_uuid(),
  source_system text not null check (source_system in ('hubspot', 'manual_finance')),
  external_company_id text,
  legal_name text not null check (char_length(trim(legal_name)) > 0),
  domain text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((source_system = 'hubspot' and external_company_id is not null) or source_system = 'manual_finance'),
  unique (source_system, external_company_id)
);

create table public.b2b_deals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.b2b_companies(id),
  source_system text not null check (source_system in ('hubspot', 'manual_finance')),
  external_deal_id text,
  name text not null check (char_length(trim(name)) > 0),
  stage_code text not null references public.b2b_deal_stages(code),
  financial_status text not null default 'complete' check (financial_status in ('complete', 'needs_review')),
  duplicate_review_status text not null default 'clear' check (duplicate_review_status in ('clear', 'needs_review', 'include', 'exclude')),
  local_record_status text not null default 'active' check (local_record_status in ('active', 'excluded')),
  pipeline_original_amount numeric(20, 6) check (pipeline_original_amount >= 0),
  original_currency char(3) check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) check (exchange_rate_to_usd > 0),
  pipeline_amount_usd numeric(20, 6) check (pipeline_amount_usd >= 0),
  hubspot_close_date date,
  renewal_date date,
  owner_name text,
  manual_entry_reason text,
  entered_by uuid references public.profiles(id),
  source_metadata jsonb not null default '{}'::jsonb,
  imported_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((source_system = 'hubspot' and external_deal_id is not null)
    or (source_system = 'manual_finance' and manual_entry_reason is not null and entered_by is not null)),
  check (
    (financial_status = 'complete'
      and pipeline_original_amount is not null
      and original_currency is not null
      and exchange_rate_to_usd is not null
      and pipeline_amount_usd is not null)
    or (financial_status = 'needs_review'
      and pipeline_original_amount is null
      and exchange_rate_to_usd is null
      and pipeline_amount_usd is null)
  ),
  unique (source_system, external_deal_id)
);

create table public.b2b_deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.b2b_deals(id),
  stage_code text not null references public.b2b_deal_stages(code),
  changed_at timestamptz not null,
  source_system text not null check (source_system in ('hubspot', 'manual_finance')),
  external_event_id text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (deal_id, stage_code, changed_at)
);

create table public.b2b_bookings (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null unique references public.b2b_deals(id),
  source_system text not null check (source_system in ('hubspot', 'manual_finance')),
  booking_date date not null,
  original_amount numeric(20, 6) not null check (original_amount >= 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  booking_amount_usd numeric(20, 6) not null check (booking_amount_usd >= 0),
  source_reference text,
  manual_entry_reason text,
  entered_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (source_system = 'hubspot' or (source_system = 'manual_finance' and manual_entry_reason is not null and entered_by is not null))
);

create table public.b2b_invoices (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.b2b_deals(id),
  booking_id uuid references public.b2b_bookings(id),
  source_system text not null check (source_system in ('hubspot', 'manual_finance', 'accounting_system')),
  external_invoice_id text,
  invoice_number text,
  issued_on date not null,
  due_on date,
  original_amount numeric(20, 6) not null check (original_amount >= 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  invoiced_amount_usd numeric(20, 6) not null check (invoiced_amount_usd >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_system, external_invoice_id)
);

create table public.b2b_receipts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.b2b_invoices(id),
  source_system text not null check (source_system in ('manual_finance', 'accounting_system')),
  external_receipt_id text,
  received_on date not null,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  received_amount_usd numeric(20, 6) not null check (received_amount_usd > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_system, external_receipt_id)
);

-- A recognised-sale row is an explicit Finance decision. No HubSpot, booking,
-- invoice, or receipt operation is permitted to manufacture one.
create table public.b2b_recognised_sales (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.b2b_deals(id),
  booking_id uuid references public.b2b_bookings(id),
  recognised_amount numeric(20, 6) not null check (recognised_amount >= 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  recognised_amount_usd numeric(20, 6) not null check (recognised_amount_usd >= 0),
  recognition_date date not null,
  reporting_period date not null check (reporting_period = date_trunc('month', reporting_period)::date),
  reason_or_reference text not null check (char_length(trim(reason_or_reference)) > 0),
  entered_by uuid not null references public.profiles(id),
  entered_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

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

create index b2b_deals_stage_close_date_idx on public.b2b_deals (stage_code, hubspot_close_date);
create index b2b_deals_renewal_date_idx on public.b2b_deals (renewal_date) where renewal_date is not null;
create index b2b_deals_local_record_status_idx on public.b2b_deals (local_record_status);
create index b2b_deal_stage_history_deal_changed_at_idx on public.b2b_deal_stage_history (deal_id, changed_at desc);
create index b2b_bookings_booking_date_idx on public.b2b_bookings (booking_date desc);
create index b2b_recognised_sales_period_idx on public.b2b_recognised_sales (reporting_period, recognition_date);
create index b2b_invoices_deal_issued_on_idx on public.b2b_invoices (deal_id, issued_on desc);
create index b2b_receipts_invoice_received_on_idx on public.b2b_receipts (invoice_id, received_on desc);

create or replace function public.assign_manual_b2b_actor()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.source_system = 'manual_finance' then
    if auth.uid() is null then raise exception 'Manual B2B entries require an authenticated administrator'; end if;
    new.entered_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.prevent_incomplete_deal_booking()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.b2b_deals where id = new.deal_id and financial_status = 'complete') then
    raise exception 'A booking cannot be created for a B2B deal with incomplete financial data';
  end if;
  return new;
end;
$$;

create or replace function public.validate_recognised_sale()
returns trigger language plpgsql set search_path = public as $$
declare booking_deal_id uuid; deal_amount_usd numeric(20, 6); recognised_total_usd numeric(20, 6);
begin
  if auth.uid() is null then raise exception 'Recognised sales require an authenticated administrator'; end if;
  new.entered_by := auth.uid(); new.entered_at := timezone('utc', now());
  if new.original_currency = 'USD' and new.exchange_rate_to_usd <> 1 then raise exception 'USD recognised sales require an exchange rate of 1'; end if;
  new.recognised_amount_usd := round(new.recognised_amount * new.exchange_rate_to_usd, 6);
  if new.booking_id is not null then
    select deal_id into booking_deal_id from public.b2b_bookings where id = new.booking_id;
    if booking_deal_id is distinct from new.deal_id then raise exception 'Recognised sale booking must belong to the linked deal'; end if;
  end if;
  select pipeline_amount_usd into deal_amount_usd from public.b2b_deals where id = new.deal_id for update;
  if deal_amount_usd is null then raise exception 'Recognised sale requires a linked deal with a known USD amount'; end if;
  select coalesce(sum(recognised_amount_usd), 0) into recognised_total_usd from public.b2b_recognised_sales where deal_id = new.deal_id;
  if recognised_total_usd + new.recognised_amount_usd > deal_amount_usd then raise exception 'Recognised sales cannot exceed the linked deal USD amount'; end if;
  return new;
end;
$$;

create or replace function public.preserve_local_hubspot_close_date_correction()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.source_system = 'hubspot' and old.source_metadata ? 'local_override_at' then
    new.name := old.name; new.owner_name := old.owner_name; new.stage_code := old.stage_code;
    new.financial_status := old.financial_status; new.pipeline_original_amount := old.pipeline_original_amount;
    new.original_currency := old.original_currency; new.exchange_rate_to_usd := old.exchange_rate_to_usd;
    new.pipeline_amount_usd := old.pipeline_amount_usd; new.hubspot_close_date := old.hubspot_close_date;
    new.renewal_date := old.renewal_date;
    new.source_metadata := new.source_metadata || jsonb_build_object('local_override_at', old.source_metadata->'local_override_at', 'local_override_by', old.source_metadata->'local_override_by', 'local_override_reason', old.source_metadata->'local_override_reason');
  elsif old.source_system = 'hubspot' and old.source_metadata ? 'local_close_date_correction_at' and new.hubspot_close_date is null then
    new.hubspot_close_date := old.hubspot_close_date;
    new.source_metadata := new.source_metadata || jsonb_build_object('local_close_date_correction_at', old.source_metadata->'local_close_date_correction_at', 'local_close_date_correction_by', old.source_metadata->'local_close_date_correction_by', 'local_close_date_correction_reason', old.source_metadata->'local_close_date_correction_reason');
  end if;
  return new;
end;
$$;

create trigger assign_manual_deal_actor before insert on public.b2b_deals for each row execute procedure public.assign_manual_b2b_actor();
create trigger assign_manual_booking_actor before insert on public.b2b_bookings for each row execute procedure public.assign_manual_b2b_actor();
create trigger prevent_incomplete_b2b_deal_booking before insert or update of deal_id on public.b2b_bookings for each row execute procedure public.prevent_incomplete_deal_booking();
create trigger validate_manual_recognised_sale before insert on public.b2b_recognised_sales for each row execute procedure public.validate_recognised_sale();
create trigger preserve_local_hubspot_close_date_correction before update on public.b2b_deals for each row execute procedure public.preserve_local_hubspot_close_date_correction();
create trigger set_b2b_deal_stages_updated_at before update on public.b2b_deal_stages for each row execute procedure public.set_updated_at();
create trigger set_b2b_companies_updated_at before update on public.b2b_companies for each row execute procedure public.set_updated_at();
create trigger set_b2b_deals_updated_at before update on public.b2b_deals for each row execute procedure public.set_updated_at();

create or replace view public.reportable_b2b_deals with (security_invoker = true) as
select d.* from public.b2b_deals d
where d.local_record_status = 'active'
  and d.financial_status = 'complete'
  and d.duplicate_review_status in ('clear', 'include')
  and (d.stage_code <> 'closed_won' or d.hubspot_close_date is not null);
comment on view public.reportable_b2b_deals is 'B2B deals safe for dashboards and reports. Excludes locally excluded, incomplete, unresolved duplicate, and closed-won deals without a known close date.';

-- These RPCs retain the existing cross-domain audit, review, and integration
-- writes. Their referenced tables are created by their owning migrations.
create or replace function public.apply_hubspot_deal_financial_correction(p_deal_id uuid, p_amount numeric(20, 6), p_currency char(3), p_exchange_rate_to_usd numeric(20, 10), p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare target_deal public.b2b_deals%rowtype; deal_is_won boolean;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can correct HubSpot financial data'; end if;
  if p_amount < 0 or p_exchange_rate_to_usd <= 0 or char_length(trim(p_reason)) = 0 then raise exception 'Correction amount, exchange rate, and reason are required'; end if;
  select * into target_deal from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and financial_status = 'needs_review' for update;
  if not found then raise exception 'The HubSpot deal is not an incomplete record awaiting correction'; end if;
  update public.b2b_deals set financial_status = 'complete', pipeline_original_amount = p_amount, original_currency = p_currency, exchange_rate_to_usd = p_exchange_rate_to_usd, pipeline_amount_usd = p_amount * p_exchange_rate_to_usd, source_metadata = target_deal.source_metadata || jsonb_build_object('local_financial_correction_at', timezone('utc', now())::text, 'local_financial_correction_by', auth.uid()::text, 'local_financial_correction_reason', p_reason) where id = p_deal_id;
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2b_deal', p_deal_id, 'amount', jsonb_build_object('pipeline_original_amount', target_deal.pipeline_original_amount, 'original_currency', target_deal.original_currency, 'exchange_rate_to_usd', target_deal.exchange_rate_to_usd, 'pipeline_amount_usd', target_deal.pipeline_amount_usd), jsonb_build_object('pipeline_original_amount', p_amount, 'original_currency', p_currency, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'pipeline_amount_usd', p_amount * p_exchange_rate_to_usd), p_reason, coalesce(target_deal.hubspot_close_date, current_date));
  select is_won into deal_is_won from public.b2b_deal_stages where code = target_deal.stage_code;
  if deal_is_won and target_deal.hubspot_close_date is not null then
    insert into public.b2b_bookings (deal_id, source_system, booking_date, original_amount, original_currency, exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason) values (p_deal_id, 'manual_finance', target_deal.hubspot_close_date, p_amount, p_currency, p_exchange_rate_to_usd, p_amount * p_exchange_rate_to_usd, format('HubSpot deal %s', target_deal.external_deal_id), p_reason) on conflict (deal_id) do nothing;
  end if;
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note) select id, 'resolved', p_reason from public.review_flags where source_area = 'b2b_deal' and source_record_id = p_deal_id and flag_type = 'needs_follow_up' and status = 'open' on conflict (flag_id) do nothing;
end;
$$;

create or replace function public.apply_hubspot_deal_close_date_correction(p_deal_id uuid, p_close_date date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare target_deal public.b2b_deals%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can correct a HubSpot close date'; end if;
  if p_close_date is null or char_length(trim(p_reason)) = 0 then raise exception 'A close date and correction reason are required'; end if;
  select * into target_deal from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and stage_code = 'closed_won' and financial_status = 'complete' and hubspot_close_date is null for update;
  if not found then raise exception 'The HubSpot deal is not awaiting a close-date correction'; end if;
  update public.b2b_deals set hubspot_close_date = p_close_date, source_metadata = target_deal.source_metadata || jsonb_build_object('local_close_date_correction_at', timezone('utc', now())::text, 'local_close_date_correction_by', auth.uid()::text, 'local_close_date_correction_reason', p_reason) where id = p_deal_id;
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2b_deal', p_deal_id, 'date', jsonb_build_object('hubspot_close_date', target_deal.hubspot_close_date), jsonb_build_object('hubspot_close_date', p_close_date), p_reason, p_close_date);
  insert into public.b2b_bookings (deal_id, source_system, booking_date, original_amount, original_currency, exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason) values (p_deal_id, 'manual_finance', p_close_date, target_deal.pipeline_original_amount, target_deal.original_currency, target_deal.exchange_rate_to_usd, target_deal.pipeline_amount_usd, format('HubSpot deal %s', target_deal.external_deal_id), p_reason) on conflict (deal_id) do nothing;
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note) select id, 'resolved', p_reason from public.review_flags where source_area = 'b2b_deal' and source_record_id = p_deal_id and flag_type = 'needs_follow_up' and status = 'open' on conflict (flag_id) do nothing;
end;
$$;

create or replace function public.apply_hubspot_deal_local_override(p_deal_id uuid, p_name text, p_owner_name text, p_stage_code text, p_amount numeric(20, 6), p_currency char(3), p_exchange_rate_to_usd numeric(20, 10), p_close_date date, p_renewal_date date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare target_deal public.b2b_deals%rowtype; next_financial_status text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can update a HubSpot deal locally'; end if;
  if char_length(trim(p_name)) = 0 or char_length(trim(p_stage_code)) = 0 or char_length(trim(p_reason)) = 0 then raise exception 'Deal name, stage, and audit reason are required'; end if;
  if not exists (select 1 from public.b2b_deal_stages where code = p_stage_code) then raise exception 'Use an approved PLAYBOOK B2B stage'; end if;
  if (p_amount is null) <> (p_currency is null) or (p_amount is null) <> (p_exchange_rate_to_usd is null) then raise exception 'Amount, currency, and exchange rate must be supplied together or all left unavailable'; end if;
  if p_amount is not null and (p_amount < 0 or p_exchange_rate_to_usd <= 0) then raise exception 'Amount must be non-negative and exchange rate must be above zero'; end if;
  select * into target_deal from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and local_record_status = 'active' for update;
  if not found then raise exception 'The HubSpot deal is unavailable for local editing'; end if;
  if target_deal.stage_code = 'closed_won' and p_stage_code <> 'closed_won' and exists (select 1 from public.b2b_bookings where deal_id = p_deal_id) then raise exception 'A booked deal cannot be moved out of closed-won. Exclude it locally instead of rewriting booking history'; end if;
  next_financial_status := case when p_amount is null then 'needs_review' else 'complete' end;
  update public.b2b_deals set name = trim(p_name), owner_name = nullif(trim(p_owner_name), ''), stage_code = p_stage_code, financial_status = next_financial_status, pipeline_original_amount = p_amount, original_currency = p_currency, exchange_rate_to_usd = p_exchange_rate_to_usd, pipeline_amount_usd = case when p_amount is null then null else p_amount * p_exchange_rate_to_usd end, hubspot_close_date = p_close_date, renewal_date = p_renewal_date, source_metadata = target_deal.source_metadata || jsonb_build_object('local_override_at', timezone('utc', now())::text, 'local_override_by', auth.uid()::text, 'local_override_reason', p_reason) where id = p_deal_id;
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2b_deal', p_deal_id, 'other', jsonb_build_object('name', target_deal.name, 'owner_name', target_deal.owner_name, 'stage_code', target_deal.stage_code, 'pipeline_original_amount', target_deal.pipeline_original_amount, 'original_currency', target_deal.original_currency, 'exchange_rate_to_usd', target_deal.exchange_rate_to_usd, 'hubspot_close_date', target_deal.hubspot_close_date, 'renewal_date', target_deal.renewal_date), jsonb_build_object('name', trim(p_name), 'owner_name', nullif(trim(p_owner_name), ''), 'stage_code', p_stage_code, 'pipeline_original_amount', p_amount, 'original_currency', p_currency, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'hubspot_close_date', p_close_date, 'renewal_date', p_renewal_date), p_reason, coalesce(p_close_date, current_date));
  if p_stage_code = 'closed_won' and p_amount is not null and p_close_date is not null then
    insert into public.b2b_bookings (deal_id, source_system, booking_date, original_amount, original_currency, exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason) values (p_deal_id, 'manual_finance', p_close_date, p_amount, p_currency, p_exchange_rate_to_usd, p_amount * p_exchange_rate_to_usd, format('HubSpot deal %s', target_deal.external_deal_id), p_reason) on conflict (deal_id) do update set source_system = excluded.source_system, booking_date = excluded.booking_date, original_amount = excluded.original_amount, original_currency = excluded.original_currency, exchange_rate_to_usd = excluded.exchange_rate_to_usd, booking_amount_usd = excluded.booking_amount_usd, source_reference = excluded.source_reference, manual_entry_reason = excluded.manual_entry_reason;
  end if;
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note) select id, 'resolved', p_reason from public.review_flags where source_area = 'b2b_deal' and source_record_id = p_deal_id and status = 'open' on conflict (flag_id) do nothing;
  update public.integration_errors set resolved_at = timezone('utc', now()), resolved_by = auth.uid(), resolution_note = p_reason where provider = 'hubspot' and resolved_at is null and source_reference like format('HubSpot deal %s —%%', target_deal.external_deal_id);
end;
$$;

create or replace function public.exclude_hubspot_deal_locally(p_deal_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare target_deal public.b2b_deals%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can exclude a HubSpot deal locally'; end if;
  if char_length(trim(p_reason)) = 0 then raise exception 'An exclusion reason is required'; end if;
  select * into target_deal from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and local_record_status = 'active' for update;
  if not found then raise exception 'The HubSpot deal is already excluded or unavailable'; end if;
  update public.b2b_deals set local_record_status = 'excluded', source_metadata = target_deal.source_metadata || jsonb_build_object('local_exclusion_at', timezone('utc', now())::text, 'local_exclusion_by', auth.uid()::text, 'local_exclusion_reason', p_reason) where id = p_deal_id;
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2b_deal', p_deal_id, 'classification', jsonb_build_object('local_record_status', 'active'), jsonb_build_object('local_record_status', 'excluded'), p_reason, current_date);
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note) select id, 'dismissed', p_reason from public.review_flags where source_area = 'b2b_deal' and source_record_id = p_deal_id and status = 'open' on conflict (flag_id) do nothing;
  update public.integration_errors set resolved_at = timezone('utc', now()), resolved_by = auth.uid(), resolution_note = p_reason where provider = 'hubspot' and resolved_at is null and source_reference like format('HubSpot deal %s —%%', target_deal.external_deal_id);
end;
$$;

create or replace function public.resolve_hubspot_integration_error(p_error_id uuid, p_resolution_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can resolve HubSpot integration errors'; end if;
  if char_length(trim(p_resolution_note)) = 0 then raise exception 'A resolution note is required'; end if;
  update public.integration_errors set resolved_at = timezone('utc', now()), resolution_note = p_resolution_note where id = p_error_id and provider = 'hubspot' and resolved_at is null;
  if not found then raise exception 'HubSpot integration error is already resolved or does not exist'; end if;
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note) select id, 'resolved', p_resolution_note from public.review_flags where source_area = 'integration' and source_record_id = p_error_id and flag_type = 'needs_follow_up' and status = 'open' on conflict (flag_id) do nothing;
end;
$$;

create or replace function public.flag_hubspot_possible_duplicates(p_deal_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare src public.b2b_deals%rowtype; group_key text; v_group_id uuid; v_group_status text;
begin
  select * into src from public.b2b_deals where id = p_deal_id and source_system = 'hubspot' and financial_status = 'complete';
  if not found then return; end if;
  group_key := md5(lower(trim(src.name)) || '|' || src.stage_code || '|' || src.pipeline_amount_usd::text || '|' || coalesce(src.hubspot_close_date::text, 'none'));
  if (select count(*) from public.b2b_deals d where d.source_system = 'hubspot' and d.financial_status = 'complete' and lower(trim(d.name)) = lower(trim(src.name)) and d.stage_code = src.stage_code and d.pipeline_amount_usd = src.pipeline_amount_usd and d.hubspot_close_date is not distinct from src.hubspot_close_date) < 2 then return; end if;
  insert into public.b2b_duplicate_groups (fingerprint) values (group_key) on conflict (fingerprint) do nothing;
  select id, status into v_group_id, v_group_status from public.b2b_duplicate_groups where fingerprint = group_key;
  if v_group_status = 'resolved' then return; end if;
  insert into public.b2b_duplicate_group_members (group_id, deal_id) select v_group_id, d.id from public.b2b_deals d where d.source_system = 'hubspot' and d.financial_status = 'complete' and lower(trim(d.name)) = lower(trim(src.name)) and d.stage_code = src.stage_code and d.pipeline_amount_usd = src.pipeline_amount_usd and d.hubspot_close_date is not distinct from src.hubspot_close_date on conflict (group_id, deal_id) do nothing;
  update public.b2b_deals set duplicate_review_status = 'needs_review' where id in (select deal_id from public.b2b_duplicate_group_members where group_id = v_group_id);
  insert into public.review_flags (source_area, source_record_id, flag_type, status, priority, reason) select 'b2b_deal', deal_id, 'possible_duplicate', 'open', 2, 'Potential duplicate HubSpot deal; Admin must choose whether to include both or keep one.' from public.b2b_duplicate_group_members where group_id = v_group_id on conflict (source_area, source_record_id, flag_type, status) do nothing;
end;
$$;

create or replace function public.flag_manual_b2b_possible_duplicates(p_deal_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare src public.b2b_deals%rowtype; group_key text; v_group_id uuid; v_group_status text;
begin
  select * into src from public.b2b_deals where id = p_deal_id and source_system = 'manual_finance' and local_record_status = 'active' and financial_status = 'complete';
  if not found then return; end if;
  group_key := md5('manual_finance|' || lower(trim(src.name)) || '|' || src.stage_code || '|' || src.pipeline_amount_usd::text || '|' || coalesce(src.hubspot_close_date::text, 'none'));
  if (select count(*) from public.b2b_deals d where d.source_system = 'manual_finance' and d.local_record_status = 'active' and d.financial_status = 'complete' and lower(trim(d.name)) = lower(trim(src.name)) and d.stage_code = src.stage_code and d.pipeline_amount_usd = src.pipeline_amount_usd and d.hubspot_close_date is not distinct from src.hubspot_close_date) < 2 then return; end if;
  insert into public.b2b_duplicate_groups (fingerprint) values (group_key) on conflict (fingerprint) do nothing;
  select id, status into v_group_id, v_group_status from public.b2b_duplicate_groups where fingerprint = group_key;
  if v_group_status = 'resolved' then return; end if;
  insert into public.b2b_duplicate_group_members (group_id, deal_id) select v_group_id, d.id from public.b2b_deals d where d.source_system = 'manual_finance' and d.local_record_status = 'active' and d.financial_status = 'complete' and lower(trim(d.name)) = lower(trim(src.name)) and d.stage_code = src.stage_code and d.pipeline_amount_usd = src.pipeline_amount_usd and d.hubspot_close_date is not distinct from src.hubspot_close_date on conflict (group_id, deal_id) do nothing;
  update public.b2b_deals set duplicate_review_status = 'needs_review' where id in (select deal_id from public.b2b_duplicate_group_members where group_id = v_group_id);
  insert into public.review_flags (source_area, source_record_id, flag_type, status, priority, reason) select 'b2b_deal', deal_id, 'possible_duplicate', 'open', 2, 'Potential duplicate manual B2B deal; Admin must choose whether to include both or keep one.' from public.b2b_duplicate_group_members where group_id = v_group_id on conflict (source_area, source_record_id, flag_type, status) do nothing;
end;
$$;

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
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note) select id, 'resolved', p_note from public.review_flags where source_area = 'b2b_deal' and source_record_id in (select deal_id from public.b2b_duplicate_group_members where group_id = p_group_id) and flag_type = 'possible_duplicate' and status = 'open' on conflict (flag_id) do nothing;
end;
$$;

create or replace function public.create_manual_b2b_deal(p_company_name text, p_name text, p_owner_name text, p_stage_code text, p_original_amount numeric(20, 6), p_original_currency char(3), p_exchange_rate_to_usd numeric(20, 10), p_close_date date, p_renewal_date date, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company_id uuid; v_deal_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can create a manual B2B deal'; end if;
  if char_length(trim(p_company_name)) = 0 or char_length(trim(p_name)) = 0 or char_length(trim(p_reason)) = 0 then raise exception 'Company, deal name, and entry reason are required'; end if;
  if not exists (select 1 from public.b2b_deal_stages where code = p_stage_code) then raise exception 'Use an approved PLAYBOOK B2B stage'; end if;
  if p_original_amount is null or p_original_amount < 0 or p_exchange_rate_to_usd is null or p_exchange_rate_to_usd <= 0 then raise exception 'Original amount must be non-negative and exchange rate must be above zero'; end if;
  if p_original_currency is null or p_original_currency !~ '^[A-Z]{3}$' then raise exception 'Use an uppercase ISO currency code'; end if;
  if p_stage_code = 'closed_won' and p_close_date is null then raise exception 'Closed-won deals require a close date before a booking can be recorded'; end if;
  select id into v_company_id from public.b2b_companies where source_system = 'manual_finance' and lower(trim(legal_name)) = lower(trim(p_company_name)) order by created_at limit 1;
  if v_company_id is null then insert into public.b2b_companies (source_system, legal_name) values ('manual_finance', trim(p_company_name)) returning id into v_company_id; end if;
  insert into public.b2b_deals (company_id, source_system, name, stage_code, financial_status, pipeline_original_amount, original_currency, exchange_rate_to_usd, pipeline_amount_usd, hubspot_close_date, renewal_date, owner_name, manual_entry_reason, source_metadata) values (v_company_id, 'manual_finance', trim(p_name), p_stage_code, 'complete', p_original_amount, p_original_currency, p_exchange_rate_to_usd, p_original_amount * p_exchange_rate_to_usd, p_close_date, p_renewal_date, nullif(trim(p_owner_name), ''), trim(p_reason), jsonb_build_object('entry_mode', 'manual_finance', 'manual_entry_at', timezone('utc', now())::text, 'manual_entry_by', auth.uid()::text)) returning id into v_deal_id;
  insert into public.b2b_deal_stage_history (deal_id, stage_code, changed_at, source_system) values (v_deal_id, p_stage_code, timezone('utc', now()), 'manual_finance');
  if p_stage_code = 'closed_won' then insert into public.b2b_bookings (deal_id, source_system, booking_date, original_amount, original_currency, exchange_rate_to_usd, booking_amount_usd, source_reference, manual_entry_reason) values (v_deal_id, 'manual_finance', p_close_date, p_original_amount, p_original_currency, p_exchange_rate_to_usd, p_original_amount * p_exchange_rate_to_usd, format('Manual Finance deal %s', v_deal_id), trim(p_reason)); end if;
  perform public.flag_manual_b2b_possible_duplicates(v_deal_id);
  return v_deal_id;
end;
$$;

alter table public.b2b_deal_stages enable row level security;
alter table public.b2b_companies enable row level security;
alter table public.b2b_deals enable row level security;
alter table public.b2b_deal_stage_history enable row level security;
alter table public.b2b_bookings enable row level security;
alter table public.b2b_invoices enable row level security;
alter table public.b2b_receipts enable row level security;
alter table public.b2b_recognised_sales enable row level security;
alter table public.b2b_duplicate_groups enable row level security;
alter table public.b2b_duplicate_group_members enable row level security;

create policy approved_read on public.b2b_deal_stages for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_companies for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_deals for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_deal_stage_history for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_bookings for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_invoices for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_receipts for select to authenticated using (public.is_approved_user());
create policy approved_read on public.b2b_recognised_sales for select to authenticated using (public.is_approved_user());
create policy b2b_duplicate_groups_read_admin on public.b2b_duplicate_groups for select to authenticated using (public.is_admin());
create policy b2b_duplicate_group_members_read_admin on public.b2b_duplicate_group_members for select to authenticated using (public.is_admin());

create policy admin_insert on public.b2b_deal_stages for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_companies for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_deals for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_deal_stage_history for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_bookings for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_invoices for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_receipts for insert to authenticated with check (public.is_admin());
create policy admin_insert on public.b2b_recognised_sales for insert to authenticated with check (public.is_admin());
create policy admin_update on public.b2b_deal_stages for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_update on public.b2b_companies for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_update on public.b2b_deals for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_update on public.b2b_deal_stage_history for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.reportable_b2b_deals from public;
grant select on public.b2b_deal_stages, public.b2b_companies, public.b2b_deals, public.b2b_deal_stage_history, public.b2b_bookings, public.b2b_invoices, public.b2b_receipts, public.b2b_recognised_sales, public.b2b_duplicate_groups, public.b2b_duplicate_group_members, public.reportable_b2b_deals to authenticated;
grant insert on public.b2b_deal_stages, public.b2b_companies, public.b2b_deals, public.b2b_deal_stage_history, public.b2b_bookings, public.b2b_invoices, public.b2b_receipts, public.b2b_recognised_sales to authenticated;
grant update on public.b2b_deal_stages, public.b2b_companies, public.b2b_deals, public.b2b_deal_stage_history to authenticated;

revoke all on function public.assign_manual_b2b_actor() from public;
revoke all on function public.prevent_incomplete_deal_booking() from public;
revoke all on function public.validate_recognised_sale() from public;
revoke all on function public.preserve_local_hubspot_close_date_correction() from public;
revoke all on function public.apply_hubspot_deal_financial_correction(uuid, numeric, char, numeric, text) from public;
revoke all on function public.apply_hubspot_deal_close_date_correction(uuid, date, text) from public;
revoke all on function public.apply_hubspot_deal_local_override(uuid, text, text, text, numeric, char, numeric, date, date, text) from public;
revoke all on function public.exclude_hubspot_deal_locally(uuid, text) from public;
revoke all on function public.resolve_hubspot_integration_error(uuid, text) from public;
revoke all on function public.flag_hubspot_possible_duplicates(uuid) from public;
revoke all on function public.flag_manual_b2b_possible_duplicates(uuid) from public;
revoke all on function public.resolve_hubspot_duplicate_group(uuid, text, uuid, text) from public;
revoke all on function public.create_manual_b2b_deal(text, text, text, text, numeric, char, numeric, date, date, text) from public;
grant execute on function public.apply_hubspot_deal_financial_correction(uuid, numeric, char, numeric, text) to authenticated;
grant execute on function public.apply_hubspot_deal_close_date_correction(uuid, date, text) to authenticated;
grant execute on function public.apply_hubspot_deal_local_override(uuid, text, text, text, numeric, char, numeric, date, date, text) to authenticated;
grant execute on function public.exclude_hubspot_deal_locally(uuid, text) to authenticated;
grant execute on function public.resolve_hubspot_integration_error(uuid, text) to authenticated;
grant execute on function public.resolve_hubspot_duplicate_group(uuid, text, uuid, text) to authenticated;
grant execute on function public.create_manual_b2b_deal(text, text, text, text, numeric, char, numeric, date, date, text) to authenticated;
grant execute on function public.flag_hubspot_possible_duplicates(uuid) to service_role;

comment on function public.create_manual_b2b_deal(text, text, text, text, numeric, char, numeric, date, date, text) is 'Admin-only local Finance B2B entry. Creates a separate booking only for a closed-won deal with a close date; never creates receipts or recognised sales and never writes to HubSpot.';
