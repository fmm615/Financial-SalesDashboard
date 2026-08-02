-- Corrections are separate, append-only journal records. They never mutate a source
-- payment, booking, or recognised-sale row.
create table public.financial_corrections (
  id uuid primary key default gen_random_uuid(),
  target_area text not null check (target_area in ('b2c_payment', 'b2b_booking', 'b2b_recognised_sale', 'expense')),
  target_record_id uuid not null,
  correction_type text not null check (correction_type in ('amount', 'date', 'category', 'classification', 'other')),
  before_value jsonb not null,
  after_value jsonb not null,
  reason text not null check (char_length(trim(reason)) > 0),
  effective_on date not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (before_value <> after_value)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_category text not null check (char_length(trim(expense_category)) > 0),
  description text not null check (char_length(trim(description)) > 0),
  original_amount numeric(20, 6) not null check (original_amount >= 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd >= 0),
  incurred_on date not null,
  source_reference text,
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.cash_position_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_label text not null check (char_length(trim(account_label)) > 0),
  snapshot_on date not null,
  original_amount numeric(20, 6) not null,
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null,
  source_reference text,
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (account_label, snapshot_on)
);

create table public.financial_targets (
  id uuid primary key default gen_random_uuid(),
  metric_code text not null check (metric_code ~ '^[a-z0-9][a-z0-9_-]*$'),
  period_start date not null,
  period_end date not null,
  target_amount_usd numeric(20, 6) not null check (target_amount_usd >= 0),
  notes text,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  unique (metric_code, period_start, period_end)
);

create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$' and base_currency <> 'USD'),
  quote_currency char(3) not null default 'USD' check (quote_currency = 'USD'),
  rate numeric(20, 10) not null check (rate > 0),
  source_system text not null check (source_system in ('manual_finance', 'provider')),
  source_reference text,
  entered_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (rate_date, base_currency, quote_currency, source_system)
);

create table public.summit_targets (
  id uuid primary key default gen_random_uuid(),
  metric_code text not null check (metric_code in ('tickets', 'sponsors', 'booths', 'revenue', 'costs')),
  period_start date not null,
  period_end date not null,
  target_value numeric(20, 6) not null check (target_value >= 0),
  value_currency char(3) check (value_currency is null or value_currency ~ '^[A-Z]{3}$'),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  check ((metric_code in ('revenue', 'costs') and value_currency is not null)
    or (metric_code not in ('revenue', 'costs') and value_currency is null)),
  unique (metric_code, period_start, period_end)
);

create table public.summit_updates (
  id uuid primary key default gen_random_uuid(),
  metric_code text not null check (metric_code in ('tickets', 'sponsors', 'booths', 'revenue', 'costs')),
  update_date date not null,
  value numeric(20, 6) not null,
  original_currency char(3) check (original_currency is null or original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) check (exchange_rate_to_usd is null or exchange_rate_to_usd > 0),
  value_usd numeric(20, 6),
  reason_or_reference text not null check (char_length(trim(reason_or_reference)) > 0),
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check ((metric_code in ('revenue', 'costs') and original_currency is not null and exchange_rate_to_usd is not null and value_usd is not null)
    or (metric_code not in ('revenue', 'costs') and original_currency is null and exchange_rate_to_usd is null and value_usd is null))
);

-- Coverage rows tell the UI whether an empty result means zero, unavailable history,
-- a partial backfill, or a complete loaded period.
create table public.data_coverage (
  id uuid primary key default gen_random_uuid(),
  domain_area text not null check (domain_area in ('b2c', 'b2b', 'finance', 'summit')),
  source_system text not null,
  period_start date not null,
  period_end date not null,
  coverage_status public.backfill_status not null,
  source_record_count integer check (source_record_count is null or source_record_count >= 0),
  notes text,
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  unique (domain_area, source_system, period_start, period_end)
);

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
    -- NEW is a trigger record shared by several tables. JSON access avoids looking
    -- for source_system on a target/coverage row, where that column does not exist.
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

create trigger assign_correction_actor before insert on public.financial_corrections
  for each row execute procedure public.assign_finance_actor();
create trigger assign_expense_actor before insert on public.expenses
  for each row execute procedure public.assign_finance_actor();
create trigger assign_cash_snapshot_actor before insert on public.cash_position_snapshots
  for each row execute procedure public.assign_finance_actor();
create trigger assign_financial_target_actor before insert or update on public.financial_targets
  for each row execute procedure public.assign_finance_actor();
create trigger assign_exchange_rate_actor before insert on public.exchange_rates
  for each row execute procedure public.assign_finance_actor();
create trigger assign_summit_target_actor before insert or update on public.summit_targets
  for each row execute procedure public.assign_finance_actor();
create trigger assign_summit_update_actor before insert on public.summit_updates
  for each row execute procedure public.assign_finance_actor();
create trigger assign_coverage_actor before insert or update on public.data_coverage
  for each row execute procedure public.assign_finance_actor();

create trigger set_financial_targets_updated_at before update on public.financial_targets
  for each row execute procedure public.set_updated_at();
create trigger set_summit_targets_updated_at before update on public.summit_targets
  for each row execute procedure public.set_updated_at();
create trigger set_data_coverage_updated_at before update on public.data_coverage
  for each row execute procedure public.set_updated_at();
