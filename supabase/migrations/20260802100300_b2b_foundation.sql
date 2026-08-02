create table public.b2b_deal_stages (
  code text primary key check (code ~ '^[a-z0-9][a-z0-9_-]*$'),
  label text not null,
  display_order integer not null unique check (display_order >= 0),
  is_closed boolean not null default false,
  is_won boolean not null default false,
  check (not is_won or is_closed),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.b2b_deal_stages (code, label, display_order, is_closed, is_won)
values
  ('discovery', 'Discovery', 10, false, false),
  ('qualified', 'Qualified', 20, false, false),
  ('proposal', 'Proposal', 30, false, false),
  ('negotiation', 'Negotiation', 40, false, false),
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
  check ((source_system = 'hubspot' and external_company_id is not null) or source_system = 'manual_finance')
);

create unique index b2b_companies_external_id_unique
  on public.b2b_companies (source_system, external_company_id)
  where external_company_id is not null;

create table public.b2b_deals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.b2b_companies(id),
  source_system text not null check (source_system in ('hubspot', 'manual_finance')),
  external_deal_id text,
  name text not null check (char_length(trim(name)) > 0),
  stage_code text not null references public.b2b_deal_stages(code),
  pipeline_original_amount numeric(20, 6) not null check (pipeline_original_amount >= 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  pipeline_amount_usd numeric(20, 6) not null check (pipeline_amount_usd >= 0),
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
    or (source_system = 'manual_finance' and manual_entry_reason is not null and entered_by is not null))
);

create unique index b2b_deals_external_id_unique
  on public.b2b_deals (source_system, external_deal_id)
  where external_deal_id is not null;

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
  check ((source_system = 'hubspot')
    or (source_system = 'manual_finance' and manual_entry_reason is not null and entered_by is not null))
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

-- These rows are deliberately manual in version one. No booking, invoice, receipt,
-- or HubSpot trigger is permitted to manufacture recognised sales.
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

create or replace function public.assign_manual_b2b_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_system = 'manual_finance' then
    if auth.uid() is null then
      raise exception 'Manual B2B entries require an authenticated administrator';
    end if;
    new.entered_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.validate_recognised_sale()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  booking_deal_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Recognised sales require an authenticated administrator';
  end if;
  new.entered_by := auth.uid();
  new.entered_at := timezone('utc', now());

  if new.booking_id is not null then
    select deal_id into booking_deal_id from public.b2b_bookings where id = new.booking_id;
    if booking_deal_id is distinct from new.deal_id then
      raise exception 'Recognised sale booking must belong to the linked deal';
    end if;
  end if;
  return new;
end;
$$;

create trigger assign_manual_deal_actor before insert on public.b2b_deals
  for each row execute procedure public.assign_manual_b2b_actor();
create trigger assign_manual_booking_actor before insert on public.b2b_bookings
  for each row execute procedure public.assign_manual_b2b_actor();
create trigger validate_manual_recognised_sale before insert on public.b2b_recognised_sales
  for each row execute procedure public.validate_recognised_sale();

create trigger set_b2b_deal_stages_updated_at before update on public.b2b_deal_stages
  for each row execute procedure public.set_updated_at();
create trigger set_b2b_companies_updated_at before update on public.b2b_companies
  for each row execute procedure public.set_updated_at();
create trigger set_b2b_deals_updated_at before update on public.b2b_deals
  for each row execute procedure public.set_updated_at();
