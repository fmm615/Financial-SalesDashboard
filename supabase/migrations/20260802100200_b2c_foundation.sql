create table public.customers (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  full_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  internal_code text not null unique check (internal_code ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null check (char_length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.product_mappings (
  id uuid primary key default gen_random_uuid(),
  source_system text not null check (source_system in ('stripe', 'tap')),
  external_product_id text not null check (char_length(trim(external_product_id)) > 0),
  product_id uuid not null references public.products(id),
  category_code text not null check (char_length(trim(category_code)) > 0),
  membership_tier text,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (source_system, external_product_id)
);

create table public.b2c_payments (
  id uuid primary key default gen_random_uuid(),
  source_system text not null check (source_system in ('stripe', 'tap', 'manual_bank_transfer')),
  provider_transaction_id text,
  provider_event_id text,
  customer_id uuid references public.customers(id),
  customer_email citext not null,
  product_mapping_id uuid references public.product_mappings(id),
  category_code text not null check (char_length(trim(category_code)) > 0),
  membership_tier text,
  payment_status text not null check (payment_status in ('succeeded', 'failed', 'pending')),
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  gross_amount_usd numeric(20, 6) not null check (gross_amount_usd > 0),
  tax_amount_usd numeric(20, 6),
  net_amount_usd numeric(20, 6),
  occurred_at timestamptz not null,
  occurred_on date not null,
  imported_at timestamptz not null default timezone('utc', now()),
  duplicate_fingerprint char(64) not null check (duplicate_fingerprint ~ '^[0-9a-f]{64}$'),
  reconciliation_source text,
  source_metadata jsonb not null default '{}'::jsonb,
  manual_entry_reason text,
  entered_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((source_system in ('stripe', 'tap') and provider_transaction_id is not null)
    or source_system = 'manual_bank_transfer'),
  check ((source_system = 'manual_bank_transfer' and entered_by is not null and manual_entry_reason is not null)
    or source_system <> 'manual_bank_transfer'),
  check (tax_amount_usd is null or net_amount_usd is null or gross_amount_usd = tax_amount_usd + net_amount_usd)
);

create unique index b2c_payments_provider_transaction_unique
  on public.b2c_payments (source_system, provider_transaction_id)
  where provider_transaction_id is not null;

create table public.b2c_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id),
  source_system text not null check (source_system in ('stripe', 'tap', 'manual_bank_transfer')),
  provider_refund_id text,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  reason text,
  occurred_at timestamptz not null,
  imported_at timestamptz not null default timezone('utc', now()),
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_system, provider_refund_id)
);

create or replace function public.assign_manual_b2c_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_system = 'manual_bank_transfer' then
    if auth.uid() is null then
      raise exception 'Manual B2C entries require an authenticated administrator';
    end if;
    new.entered_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.prevent_refund_overage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  original_payment_amount numeric(20, 6);
  refunded_total numeric(20, 6);
begin
  select amount_usd into original_payment_amount
  from public.b2c_payments
  where id = new.payment_id
  for update;

  if original_payment_amount is null then
    raise exception 'Refund payment % does not exist', new.payment_id;
  end if;

  select coalesce(sum(amount_usd), 0) into refunded_total
  from public.b2c_refunds
  where payment_id = new.payment_id
    and id is distinct from new.id;

  if refunded_total + new.amount_usd > original_payment_amount then
    raise exception 'Refund total cannot exceed original payment amount';
  end if;

  return new;
end;
$$;

create trigger assign_b2c_manual_actor
  before insert on public.b2c_payments
  for each row execute procedure public.assign_manual_b2c_actor();
create trigger prevent_b2c_refund_overage
  before insert or update on public.b2c_refunds
  for each row execute procedure public.prevent_refund_overage();

create trigger set_customers_updated_at before update on public.customers
  for each row execute procedure public.set_updated_at();
create trigger set_products_updated_at before update on public.products
  for each row execute procedure public.set_updated_at();
create trigger set_product_mappings_updated_at before update on public.product_mappings
  for each row execute procedure public.set_updated_at();
create trigger set_b2c_payments_updated_at before update on public.b2c_payments
  for each row execute procedure public.set_updated_at();
