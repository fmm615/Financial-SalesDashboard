-- Clean-slate consolidated migration (B2C domain): the FINAL, POST-REMOVAL
-- B2C schema. This replaces ~30 incremental migrations (b2c/stripe/tap
-- foundation, source-metadata additions, FX retention, Finance exceptions,
-- Stripe/Tap enrichment, the content-fingerprint duplicate-group system, and
-- the retirement of the mandatory product-mapping workflow) with the shape
-- they left behind once replayed in order.
--
-- Deliberately EXCLUDED (the entire removed Payment Tracker Excel-workbook
-- system -- see supabase/migrations/20260901100000_remove_payment_tracker_sheet_system.sql,
-- whose DROP statements are authoritative for this list): b2c_finance_imports,
-- b2c_finance_staging_rows, b2c_provider_evidence, b2c_provider_evidence_payment_links,
-- b2c_reconciliation_groups, b2c_reconciliation_finance_rows,
-- b2c_reconciliation_provider_evidence, b2c_reconciliation_decisions,
-- b2c_finance_row_overrides, b2c_finance_record_lineages,
-- b2c_finance_row_lineage_links, b2c_finance_import_version_candidates,
-- b2c_finance_import_version_decisions, b2c_finance_ledger_posts,
-- b2c_finance_ledger_adjustments -- none of these exist here.
--
-- This domain's workflow RPCs (apply_stripe_product_mapping,
-- apply_b2c_product_mapping, apply_b2c_payment_local_correction,
-- include_b2c_payment_with_finance_exception, record_b2c_payment_fx_conversion,
-- record_b2c_refund_fx_conversion, open_b2c_payment_duplicate_group and its two
-- after-write triggers, resolve_b2c_payment_duplicate_group,
-- dismiss_stale_b2c_possible_duplicate_flag, get_b2c_payment_duplicate_reporting_states,
-- get_b2c_stripe_payment_contact_fallbacks, get_b2c_stripe_payment_evidence) ARE
-- included below in their final form, even though several of them write
-- public.financial_corrections / public.review_flags / public.review_flag_resolutions,
-- which are created by 20270101000300_finance_targets_reports.sql (applied
-- after this one). A later-numbered migration creating those tables is fine:
-- PL/pgSQL function bodies are late-bound, so CREATE FUNCTION here does not
-- require those tables to exist yet, only by the time these RPCs are actually
-- called (mirrors how Task 2's b2b_foundation migration keeps
-- apply_hubspot_deal_financial_correction and friends in its own file).
--
-- The only thing genuinely deferred to a final cross-cutting sweep migration
-- is attaching the generic `audit_%` trigger (public.write_audit_event(),
-- owned by the Finance/Targets/Reports/Audit domain) to this domain's tables,
-- exactly as every other domain migration defers it and as
-- 20270101000000_foundation_and_access.sql documents for its own tables.
--
-- record_b2c_manual_bank_transfer is included in its FINAL TRIMMED form,
-- copied verbatim from 20260901100000_remove_payment_tracker_sheet_system.sql:
-- a bank-reference exact-match check plus the generic 48-hour content-duplicate
-- fingerprint (the Payment-Tracker-lineage check that migration removed is
-- gone). It has no dependency beyond public.b2c_payments.

-- ---------------------------------------------------------------------------
-- Customers, products, product mappings (product_mappings in its RETIRED-
-- OPTIONAL final state: readable historical evidence only, no authenticated
-- write path -- see 20260824150000_retire_b2c_product_mapping_requirement.sql).
-- ---------------------------------------------------------------------------

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

create trigger set_customers_updated_at before update on public.customers
  for each row execute procedure public.set_updated_at();
create trigger set_products_updated_at before update on public.products
  for each row execute procedure public.set_updated_at();
create trigger set_product_mappings_updated_at before update on public.product_mappings
  for each row execute procedure public.set_updated_at();

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.product_mappings enable row level security;

create policy approved_read on public.customers for select to authenticated using (public.is_approved_user());
create policy admin_insert on public.customers for insert to authenticated with check (public.is_admin());
create policy admin_update on public.customers for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy approved_read on public.products for select to authenticated using (public.is_approved_user());
create policy admin_insert on public.products for insert to authenticated with check (public.is_admin());
create policy admin_update on public.products for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Retired: the browser mapping workflow was removed, so only the select
-- policy remains. No insert/update policy exists and neither grant is given.
create policy approved_read on public.product_mappings for select to authenticated using (public.is_approved_user());

revoke all on public.customers, public.products, public.product_mappings from anon;
grant select, insert, update on public.customers to authenticated;
grant select, insert, update on public.products to authenticated;
grant select on public.product_mappings to authenticated;

-- ---------------------------------------------------------------------------
-- b2c_payments / b2c_refunds. FX columns are nullable: a foreign-currency
-- Stripe/Tap source row is retained without an invented USD conversion until
-- Finance records one via b2c_payment_fx_conversions (see below). The
-- `finance_tracker` source_system value is retained for historical ledger
-- rows the (now-removed) Payment Tracker posting workflow created; it is not
-- currently reachable by any live write path in this schema.
-- ---------------------------------------------------------------------------

create table public.b2c_payments (
  id uuid primary key default gen_random_uuid(),
  source_system text not null check (source_system in ('stripe', 'tap', 'manual_bank_transfer', 'finance_tracker')),
  provider_transaction_id text,
  provider_event_id text,
  customer_id uuid references public.customers(id),
  customer_email citext,
  customer_name text,
  customer_phone text,
  product_mapping_id uuid references public.product_mappings(id),
  category_code text not null check (char_length(trim(category_code)) > 0),
  membership_tier text,
  payment_status text not null check (payment_status in ('succeeded', 'failed', 'pending')),
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) check (amount_usd > 0),
  gross_amount_usd numeric(20, 6) check (gross_amount_usd > 0),
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
  constraint b2c_payments_customer_phone_length_check
    check (customer_phone is null or char_length(trim(customer_phone)) between 5 and 40),
  constraint b2c_payments_customer_name_length_check
    check (customer_name is null or char_length(customer_name) <= 200),
  constraint b2c_payments_provider_transaction_requirement_check check (
    (source_system in ('stripe', 'tap') and provider_transaction_id is not null)
    or source_system in ('manual_bank_transfer', 'finance_tracker')
  ),
  constraint b2c_payments_manual_entry_requirement_check check (
    (source_system = 'manual_bank_transfer' and entered_by is not null and manual_entry_reason is not null)
    or source_system <> 'manual_bank_transfer'
  ),
  constraint b2c_payments_tax_net_gross_check
    check (tax_amount_usd is null or net_amount_usd is null or gross_amount_usd = tax_amount_usd + net_amount_usd),
  -- A Stripe/Tap source row is either a complete USD reporting record or a
  -- retained foreign-currency source record with no invented USD conversion.
  constraint b2c_payments_stripe_currency_reporting_check check (
    source_system <> 'stripe'
    or (original_currency = 'USD' and exchange_rate_to_usd is not null and amount_usd is not null and gross_amount_usd is not null)
    or (original_currency <> 'USD' and exchange_rate_to_usd is null and amount_usd is null and gross_amount_usd is null)
  ),
  constraint b2c_payments_tap_currency_reporting_check check (
    source_system <> 'tap'
    or (original_currency = 'USD' and exchange_rate_to_usd is not null and amount_usd is not null and gross_amount_usd is not null)
    or (original_currency <> 'USD' and exchange_rate_to_usd is null and amount_usd is null and gross_amount_usd is null)
  )
);

create unique index b2c_payments_provider_transaction_unique
  on public.b2c_payments (source_system, provider_transaction_id)
  where provider_transaction_id is not null;

create index b2c_payments_customer_email_idx on public.b2c_payments (customer_email);
create index b2c_payments_occurred_on_idx on public.b2c_payments (occurred_on desc);
create index b2c_payments_status_occurred_on_idx on public.b2c_payments (payment_status, occurred_on desc);
create index b2c_payments_fingerprint_occurred_at_idx on public.b2c_payments (duplicate_fingerprint, occurred_at desc);
create index b2c_payments_stripe_product_reference_idx
  on public.b2c_payments ((source_metadata ->> 'product_reference'))
  where source_system = 'stripe';
create index b2c_payments_tap_product_reference_idx
  on public.b2c_payments ((source_metadata ->> 'product_reference'))
  where source_system = 'tap';

create table public.b2c_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id),
  source_system text not null check (source_system in ('stripe', 'tap', 'manual_bank_transfer', 'finance_tracker')),
  provider_refund_id text,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency char(3) not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) check (amount_usd > 0),
  reason text,
  occurred_at timestamptz not null,
  imported_at timestamptz not null default timezone('utc', now()),
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_system, provider_refund_id),
  constraint b2c_refunds_stripe_currency_reporting_check check (
    source_system <> 'stripe'
    or (original_currency = 'USD' and exchange_rate_to_usd is not null and amount_usd is not null)
    or (original_currency <> 'USD' and exchange_rate_to_usd is null and amount_usd is null)
  ),
  constraint b2c_refunds_tap_currency_reporting_check check (
    source_system <> 'tap'
    or (original_currency = 'USD' and exchange_rate_to_usd is not null and amount_usd is not null)
    or (original_currency <> 'USD' and exchange_rate_to_usd is null and amount_usd is null)
  )
);

create index b2c_refunds_payment_id_idx on public.b2c_refunds (payment_id);

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

-- A foreign source refund without a recorded FX conversion has no USD value
-- to compare; the overage check is deferred (not rejected) until Finance
-- records the conversion.
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

  if not found then
    raise exception 'Refund payment % does not exist', new.payment_id;
  end if;

  if original_payment_amount is null or new.amount_usd is null then
    return new;
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

create trigger set_b2c_payments_updated_at before update on public.b2c_payments
  for each row execute procedure public.set_updated_at();

alter table public.b2c_payments enable row level security;
alter table public.b2c_refunds enable row level security;

create policy approved_read on public.b2c_payments for select to authenticated using (public.is_approved_user());
create policy admin_insert on public.b2c_payments for insert to authenticated with check (public.is_admin());

create policy approved_read on public.b2c_refunds for select to authenticated using (public.is_approved_user());
create policy admin_insert on public.b2c_refunds for insert to authenticated with check (public.is_admin());

revoke all on public.b2c_payments, public.b2c_refunds from anon;
grant select, insert on public.b2c_payments to authenticated;
grant select, insert on public.b2c_refunds to authenticated;

revoke all on function public.assign_manual_b2c_actor() from public;
revoke all on function public.prevent_refund_overage() from public;

-- ---------------------------------------------------------------------------
-- b2c_payment_local_overrides: a local PLAYBOOK reporting overlay. It never
-- updates b2c_payments or any provider source row.
-- ---------------------------------------------------------------------------

create table public.b2c_payment_local_overrides (
  payment_id uuid primary key references public.b2c_payments(id),
  customer_name text,
  customer_email citext,
  customer_phone text,
  category_code text,
  membership_tier text,
  local_amount_usd numeric(20, 6),
  local_occurred_on date,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint b2c_payment_local_overrides_has_correction_check check (
    customer_name is not null
    or customer_email is not null
    or customer_phone is not null
    or category_code is not null
    or membership_tier is not null
    or local_amount_usd is not null
    or local_occurred_on is not null
  ),
  constraint b2c_payment_local_overrides_local_amount_usd_check
    check (local_amount_usd is null or local_amount_usd > 0),
  check (customer_name is null or char_length(trim(customer_name)) between 1 and 200),
  check (customer_email is null or customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  check (customer_phone is null or char_length(trim(customer_phone)) between 5 and 40),
  check (category_code is null or category_code ~ '^[a-z0-9][a-z0-9_-]*$'),
  check (membership_tier is null or char_length(trim(membership_tier)) between 1 and 100)
);

create trigger set_b2c_payment_local_overrides_updated_at
  before update on public.b2c_payment_local_overrides
  for each row execute procedure public.set_updated_at();

-- Never allow a generic local correction to manufacture USD for a foreign
-- provider payment. FX must go through the append-only conversion workflow
-- (b2c_payment_fx_conversions below).
create or replace function public.prevent_b2c_foreign_local_usd_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  payment_currency text;
begin
  if new.local_amount_usd is null then
    return new;
  end if;
  select original_currency into payment_currency
  from public.b2c_payments where id = new.payment_id;
  if payment_currency is distinct from 'USD' then
    raise exception 'A foreign-currency payment requires a Finance-approved FX conversion; do not enter a local USD amount directly';
  end if;
  return new;
end;
$$;

create trigger prevent_b2c_foreign_local_usd_override
  before insert or update of local_amount_usd on public.b2c_payment_local_overrides
  for each row execute procedure public.prevent_b2c_foreign_local_usd_override();

alter table public.b2c_payment_local_overrides enable row level security;

create policy approved_read on public.b2c_payment_local_overrides
  for select to authenticated using (public.is_approved_user());
create policy admin_insert on public.b2c_payment_local_overrides
  for insert to authenticated with check (public.is_admin());
create policy admin_update on public.b2c_payment_local_overrides
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.b2c_payment_local_overrides from anon;
grant select, insert, update on public.b2c_payment_local_overrides to authenticated;

revoke all on function public.prevent_b2c_foreign_local_usd_override() from public;

-- ---------------------------------------------------------------------------
-- b2c_payment_finance_exception_decisions: an explicit, local, append-only
-- inclusion decision for a succeeded provider payment whose source metadata
-- is incomplete. It never changes the provider source row or provider.
-- ---------------------------------------------------------------------------

create table public.b2c_payment_finance_exception_decisions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id),
  decision text not null check (decision in ('include', 'revoke')),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  confirmed_provider_transaction boolean not null,
  confirmed_no_known_duplicate boolean not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_payment_finance_exception_decisions_latest_idx
  on public.b2c_payment_finance_exception_decisions (payment_id, created_at desc, id desc);

alter table public.b2c_payment_finance_exception_decisions enable row level security;

create policy approved_read on public.b2c_payment_finance_exception_decisions
  for select to authenticated using (public.is_approved_user());
create policy admin_insert on public.b2c_payment_finance_exception_decisions
  for insert to authenticated with check (public.is_admin());

revoke all on public.b2c_payment_finance_exception_decisions from anon;
grant select, insert on public.b2c_payment_finance_exception_decisions to authenticated;

-- ---------------------------------------------------------------------------
-- b2c_payment_fx_conversions / b2c_refund_fx_conversions: Finance-approved,
-- append-only FX evidence for a foreign-currency provider source row. These
-- deliberately never update Stripe, Tap, or the immutable provider source
-- rows. Inserts are RPC-only (record_b2c_payment_fx_conversion /
-- record_b2c_refund_fx_conversion), which belong to the cross-cutting sweep
-- migration described above since they write public.financial_corrections
-- and public.review_flag_resolutions.
-- ---------------------------------------------------------------------------

create table public.b2c_payment_fx_conversions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id) on delete restrict,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency text not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  effective_on date not null,
  conversion_source text not null check (char_length(trim(conversion_source)) between 3 and 300),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_payment_fx_conversions_latest_idx
  on public.b2c_payment_fx_conversions (payment_id, created_at desc, id desc);

alter table public.b2c_payment_fx_conversions enable row level security;
create policy approved_read on public.b2c_payment_fx_conversions
  for select to authenticated using (public.is_approved_user());
revoke all on public.b2c_payment_fx_conversions from anon;
revoke insert, update, delete on public.b2c_payment_fx_conversions from authenticated;
grant select on public.b2c_payment_fx_conversions to authenticated;

create table public.b2c_refund_fx_conversions (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.b2c_refunds(id) on delete restrict,
  original_amount numeric(20, 6) not null check (original_amount > 0),
  original_currency text not null check (original_currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_usd numeric(20, 10) not null check (exchange_rate_to_usd > 0),
  amount_usd numeric(20, 6) not null check (amount_usd > 0),
  effective_on date not null,
  conversion_source text not null check (char_length(trim(conversion_source)) between 3 and 300),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index b2c_refund_fx_conversions_latest_idx
  on public.b2c_refund_fx_conversions (refund_id, created_at desc, id desc);

alter table public.b2c_refund_fx_conversions enable row level security;
create policy approved_read on public.b2c_refund_fx_conversions
  for select to authenticated using (public.is_approved_user());
revoke all on public.b2c_refund_fx_conversions from anon;
revoke insert, update, delete on public.b2c_refund_fx_conversions from authenticated;
grant select on public.b2c_refund_fx_conversions to authenticated;

-- ---------------------------------------------------------------------------
-- b2c_stripe_payment_details / b2c_stripe_refund_details: read-only Stripe
-- enrichment and settlement evidence. Source/audit values only -- none feeds
-- B2C reportability or financial totals.
-- ---------------------------------------------------------------------------

create table public.b2c_stripe_payment_details (
  payment_id uuid primary key references public.b2c_payments(id),
  payment_intent_id text,
  payment_method_id text,
  checkout_session_id text,
  invoice_id text,
  customer_id text,
  balance_transaction_id text,
  customer_name_source text,
  customer_email_source text,
  customer_phone_source text,
  charge_customer_name text,
  charge_customer_email citext,
  charge_customer_phone text,
  checkout_customer_name text,
  checkout_customer_email citext,
  checkout_customer_phone text,
  invoice_customer_name text,
  invoice_customer_email citext,
  invoice_customer_phone text,
  payment_method_customer_name text,
  payment_method_customer_email citext,
  payment_method_customer_phone text,
  customer_profile_name text,
  customer_profile_email citext,
  customer_profile_phone text,
  charge_description text,
  seller_message text,
  cardholder_name text,
  charge_refunded_amount numeric(20,6),
  settlement_gross_amount numeric(20,6),
  settlement_fee_amount numeric(20,6),
  settlement_fee_tax_amount numeric(20,6),
  settlement_net_amount numeric(20,6),
  settlement_currency char(3),
  settlement_exchange_rate numeric(20,10),
  provider_tax_amount numeric(20,6),
  provider_tax_currency char(3),
  enrichment_status text not null,
  enrichment_issue_codes jsonb not null default '[]'::jsonb,
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint b2c_stripe_payment_details_provider_id_lengths_check check (
    (payment_intent_id is null or char_length(payment_intent_id) between 1 and 255)
    and (payment_method_id is null or char_length(payment_method_id) between 1 and 255)
    and (checkout_session_id is null or char_length(checkout_session_id) between 1 and 255)
    and (invoice_id is null or char_length(invoice_id) between 1 and 255)
    and (customer_id is null or char_length(customer_id) between 1 and 255)
    and (balance_transaction_id is null or char_length(balance_transaction_id) between 1 and 255)
  ),
  constraint b2c_stripe_payment_details_contact_sources_check check (
    (customer_name_source is null or customer_name_source in ('charge_receipt', 'charge_billing', 'charge_shipping', 'checkout_session', 'invoice_snapshot'))
    and (customer_email_source is null or customer_email_source in ('charge_receipt', 'charge_billing', 'charge_shipping', 'checkout_session', 'invoice_snapshot'))
    and (customer_phone_source is null or customer_phone_source in ('charge_receipt', 'charge_billing', 'charge_shipping', 'checkout_session', 'invoice_snapshot'))
  ),
  constraint b2c_stripe_payment_details_contact_lengths_check check (
    (charge_customer_name is null or char_length(trim(charge_customer_name)) between 1 and 200)
    and (checkout_customer_name is null or char_length(trim(checkout_customer_name)) between 1 and 200)
    and (invoice_customer_name is null or char_length(trim(invoice_customer_name)) between 1 and 200)
    and (payment_method_customer_name is null or char_length(trim(payment_method_customer_name)) between 1 and 200)
    and (customer_profile_name is null or char_length(trim(customer_profile_name)) between 1 and 200)
    and (charge_customer_phone is null or char_length(trim(charge_customer_phone)) between 5 and 40)
    and (checkout_customer_phone is null or char_length(trim(checkout_customer_phone)) between 5 and 40)
    and (invoice_customer_phone is null or char_length(trim(invoice_customer_phone)) between 5 and 40)
    and (payment_method_customer_phone is null or char_length(trim(payment_method_customer_phone)) between 5 and 40)
    and (customer_profile_phone is null or char_length(trim(customer_profile_phone)) between 5 and 40)
  ),
  constraint b2c_stripe_payment_details_contact_emails_check check (
    (charge_customer_email is null or charge_customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    and (checkout_customer_email is null or checkout_customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    and (invoice_customer_email is null or invoice_customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    and (payment_method_customer_email is null or payment_method_customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    and (customer_profile_email is null or customer_profile_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
  ),
  constraint b2c_stripe_payment_details_charge_evidence_lengths_check check (
    (charge_description is null or char_length(trim(charge_description)) between 1 and 2000)
    and (seller_message is null or char_length(trim(seller_message)) between 1 and 2000)
    and (cardholder_name is null or char_length(trim(cardholder_name)) between 1 and 200)
    and (charge_refunded_amount is null or charge_refunded_amount >= 0)
  ),
  constraint b2c_stripe_payment_details_settlement_amounts_check check (
    (settlement_gross_amount is null or settlement_gross_amount >= 0)
    and (settlement_fee_amount is null or settlement_fee_amount >= 0)
    and (settlement_fee_tax_amount is null or settlement_fee_tax_amount >= 0)
    and (settlement_net_amount is null or settlement_net_amount >= 0)
    and (provider_tax_amount is null or provider_tax_amount >= 0)
    and (settlement_fee_tax_amount is null or settlement_fee_amount is null or settlement_fee_tax_amount <= settlement_fee_amount)
  ),
  constraint b2c_stripe_payment_details_settlement_currency_check check (
    (settlement_currency is null or settlement_currency ~ '^[A-Z]{3}$')
    and (provider_tax_currency is null or provider_tax_currency ~ '^[A-Z]{3}$')
    and (settlement_gross_amount is null or settlement_currency is not null)
    and (settlement_fee_amount is null or settlement_currency is not null)
    and (settlement_fee_tax_amount is null or settlement_currency is not null)
    and (settlement_net_amount is null or settlement_currency is not null)
    and (provider_tax_amount is null or provider_tax_currency is not null)
  ),
  constraint b2c_stripe_payment_details_settlement_math_check check (
    settlement_gross_amount is null
    or settlement_fee_amount is null
    or settlement_net_amount is null
    or settlement_net_amount = settlement_gross_amount - settlement_fee_amount
  ),
  constraint b2c_stripe_payment_details_exchange_rate_check check (
    settlement_exchange_rate is null or settlement_exchange_rate > 0
  ),
  constraint b2c_stripe_payment_details_status_check check (enrichment_status in ('complete', 'partial')),
  constraint b2c_stripe_payment_details_issues_check check (jsonb_typeof(enrichment_issue_codes) = 'array')
);

create trigger set_b2c_stripe_payment_details_updated_at
  before update on public.b2c_stripe_payment_details
  for each row execute procedure public.set_updated_at();

create or replace function public.enforce_stripe_payment_details_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_source text;
begin
  select source_system into linked_source
  from public.b2c_payments
  where id = new.payment_id;

  if linked_source is distinct from 'stripe' then
    raise exception using
      errcode = '23514',
      message = 'Stripe payment details linked payment is not a Stripe payment';
  end if;

  return new;
end;
$$;

create trigger enforce_b2c_stripe_payment_details_source
  before insert or update of payment_id on public.b2c_stripe_payment_details
  for each row execute procedure public.enforce_stripe_payment_details_source();

alter table public.b2c_stripe_payment_details enable row level security;

create policy admin_read on public.b2c_stripe_payment_details
  for select to authenticated
  using (public.is_admin());

revoke all on public.b2c_stripe_payment_details from anon, authenticated;
grant select on public.b2c_stripe_payment_details to authenticated;

create table public.b2c_stripe_refund_details (
  refund_id uuid primary key references public.b2c_refunds(id) on delete cascade,
  settlement_refund_amount numeric(20,6),
  settlement_currency char(3),
  settlement_exchange_rate numeric(20,10),
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint b2c_stripe_refund_details_amount_check check (
    settlement_refund_amount is null or settlement_refund_amount >= 0
  ),
  constraint b2c_stripe_refund_details_currency_check check (
    (settlement_currency is null or settlement_currency ~ '^[A-Z]{3}$')
    and (settlement_refund_amount is null or settlement_currency is not null)
  ),
  constraint b2c_stripe_refund_details_exchange_rate_check check (
    settlement_exchange_rate is null or settlement_exchange_rate > 0
  )
);

create trigger set_b2c_stripe_refund_details_updated_at
  before update on public.b2c_stripe_refund_details
  for each row execute procedure public.set_updated_at();

create or replace function public.enforce_stripe_refund_details_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_source text;
begin
  select refund.source_system into linked_source
  from public.b2c_refunds as refund
  where refund.id = new.refund_id;

  if linked_source is distinct from 'stripe' then
    raise exception using
      errcode = '23514',
      message = 'Stripe refund details linked refund is not a Stripe refund';
  end if;

  return new;
end;
$$;

create trigger enforce_b2c_stripe_refund_details_source
  before insert or update of refund_id on public.b2c_stripe_refund_details
  for each row execute procedure public.enforce_stripe_refund_details_source();

alter table public.b2c_stripe_refund_details enable row level security;

create policy admin_read on public.b2c_stripe_refund_details
  for select to authenticated
  using (public.is_admin());

revoke all on public.b2c_stripe_refund_details from anon, authenticated;
grant select on public.b2c_stripe_refund_details to authenticated;

revoke all on function public.enforce_stripe_payment_details_source() from public;
revoke all on function public.enforce_stripe_refund_details_source() from public;

-- ---------------------------------------------------------------------------
-- b2c_payment_duplicate_groups / b2c_payment_duplicate_group_members: the
-- kept, unrelated content-fingerprint dedup system (explicitly called out as
-- untouched by the Payment Tracker removal). Provider and Finance source
-- payments remain immutable; only group/member history is written here. The
-- workflow functions that populate and resolve these groups
-- (open_b2c_payment_duplicate_group, resolve_b2c_payment_duplicate_group,
-- dismiss_stale_b2c_possible_duplicate_flag, and the two after-write
-- triggers on b2c_payments/b2c_payment_local_overrides) write
-- public.review_flags and so belong to the cross-cutting sweep migration
-- described above.
-- ---------------------------------------------------------------------------

create table public.b2c_payment_duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'resolved')),
  decision text check (decision in ('keep_all', 'keep_one')),
  canonical_payment_id uuid references public.b2c_payments(id),
  detection_reason text not null check (char_length(trim(detection_reason)) between 3 and 1000),
  resolution_reason text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (status = 'open' and decision is null and canonical_payment_id is null and resolution_reason is null and resolved_by is null and resolved_at is null)
    or
    (status = 'resolved' and decision = 'keep_all' and canonical_payment_id is null and char_length(trim(resolution_reason)) between 3 and 1000 and resolved_by is not null and resolved_at is not null)
    or
    (status = 'resolved' and decision = 'keep_one' and canonical_payment_id is not null and char_length(trim(resolution_reason)) between 3 and 1000 and resolved_by is not null and resolved_at is not null)
  )
);

create unique index b2c_payment_duplicate_groups_one_open_fingerprint_idx
  on public.b2c_payment_duplicate_groups (fingerprint)
  where status = 'open';

create table public.b2c_payment_duplicate_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.b2c_payment_duplicate_groups(id),
  payment_id uuid not null references public.b2c_payments(id),
  decision text not null default 'pending' check (decision in ('pending', 'include', 'exclude')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (group_id, payment_id)
);

create index b2c_payment_duplicate_group_members_payment_idx
  on public.b2c_payment_duplicate_group_members (payment_id, group_id);

create or replace function public.enforce_one_open_b2c_duplicate_group_per_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.b2c_payment_duplicate_groups target_group
    where target_group.id = new.group_id
      and target_group.status = 'open'
  ) and exists (
    select 1
    from public.b2c_payment_duplicate_group_members existing_member
    join public.b2c_payment_duplicate_groups existing_group on existing_group.id = existing_member.group_id
    where existing_member.payment_id = new.payment_id
      and existing_member.group_id <> new.group_id
      and existing_group.status = 'open'
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;
  return new;
end;
$$;

create trigger enforce_one_open_b2c_duplicate_group_per_payment
  before insert or update of group_id, payment_id on public.b2c_payment_duplicate_group_members
  for each row execute procedure public.enforce_one_open_b2c_duplicate_group_per_payment();

revoke all on function public.enforce_one_open_b2c_duplicate_group_per_payment() from public;

alter table public.b2c_payment_duplicate_groups enable row level security;
alter table public.b2c_payment_duplicate_group_members enable row level security;

create policy admin_select on public.b2c_payment_duplicate_groups
  for select to authenticated using (public.is_admin());
create policy admin_select on public.b2c_payment_duplicate_group_members
  for select to authenticated using (public.is_admin());

revoke all on public.b2c_payment_duplicate_groups from public, anon, authenticated;
revoke all on public.b2c_payment_duplicate_group_members from public, anon, authenticated;
grant select on public.b2c_payment_duplicate_groups to authenticated;
grant select on public.b2c_payment_duplicate_group_members to authenticated;

-- ---------------------------------------------------------------------------
-- record_b2c_manual_bank_transfer: FINAL TRIMMED form, copied verbatim from
-- 20260901100000_remove_payment_tracker_sheet_system.sql. Rejection order:
-- exact bank-reference match, then the generic 48-hour content-duplicate
-- fingerprint (retained and flagged for review, never rejected outright).
-- The third, Payment-Tracker-lineage-specific check that migration removed
-- is gone; this function has no dependency beyond public.b2c_payments.
-- ---------------------------------------------------------------------------

create or replace function public.record_b2c_manual_bank_transfer(
  p_bank_reference text, p_customer_email text, p_customer_name text,
  p_category_code text, p_membership_tier text, p_amount_usd_text text,
  p_received_at_raw text, p_reason text, p_expected_input_sha256 text
)
returns public.b2c_payments
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  actor uuid;
  computed_hash text;
  transfer_occurred_at timestamptz;
  transfer_occurred_on date;
  duplicate_fp text;
  new_payment public.b2c_payments%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a manual bank transfer';
  end if;
  actor := auth.uid();

  if char_length(trim(coalesce(p_bank_reference, ''))) not between 1 and 200 then
    raise exception 'A bank reference between 1 and 200 characters is required';
  end if;
  if char_length(trim(coalesce(p_customer_name, ''))) not between 1 and 200 then
    raise exception 'A customer name is required';
  end if;
  if p_customer_email is null or trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'A verified customer email is required';
  end if;
  if char_length(trim(coalesce(p_category_code, ''))) < 1 then
    raise exception 'A category is required';
  end if;
  if p_amount_usd_text is null or p_amount_usd_text !~ '^[0-9]+\.[0-9]{6}$' or p_amount_usd_text::numeric <= 0 then
    raise exception 'A positive USD amount with six decimal places is required';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A reason is required';
  end if;
  if coalesce(p_expected_input_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the entered details before recording them';
  end if;

  -- Postgres would resolve an offset-less timestamp in the session timezone,
  -- silently recording the wrong instant (and possibly the wrong Bahrain
  -- business date) for an Admin working elsewhere. Require the offset.
  if p_received_at_raw !~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    raise exception 'The bank transfer date/time must include an explicit UTC offset';
  end if;

  begin
    transfer_occurred_at := p_received_at_raw::timestamptz;
  exception when others then
    raise exception 'A valid bank transfer date/time with an explicit offset is required';
  end;
  transfer_occurred_on := (transfer_occurred_at at time zone 'Asia/Bahrain')::date;

  computed_hash := encode(digest(
    trim(p_bank_reference) || '|' || lower(trim(p_customer_email)) || '|' || trim(p_customer_name) || '|' ||
    trim(p_category_code) || '|' || coalesce(trim(p_membership_tier), '') || '|' ||
    p_amount_usd_text || '|' || trim(p_received_at_raw) || '|' || trim(p_reason),
    'sha256'
  ), 'hex');
  if computed_hash <> p_expected_input_sha256 then
    raise exception 'The reviewed bank transfer details changed since preview. Start again.';
  end if;

  perform pg_advisory_xact_lock(hashtext('b2c_manual_bank_transfer:' || lower(trim(p_bank_reference))));
  if exists (
    select 1 from public.b2c_payments
    where source_system = 'manual_bank_transfer' and provider_transaction_id = trim(p_bank_reference)
  ) then
    raise exception 'A manual bank transfer with this reference already exists';
  end if;

  duplicate_fp := encode(digest(
    lower(trim(p_customer_email)) || '|USD|' || p_amount_usd_text || '|' || lower(trim(p_category_code)) || '|' ||
    to_char(transfer_occurred_on, 'YYYY-MM-DD'),
    'sha256'
  ), 'hex');

  begin
    insert into public.b2c_payments (
      source_system, provider_transaction_id, customer_name, customer_email,
      category_code, membership_tier, payment_status,
      original_amount, original_currency, exchange_rate_to_usd,
      amount_usd, gross_amount_usd, occurred_at, occurred_on,
      duplicate_fingerprint, manual_entry_reason, entered_by
    ) values (
      'manual_bank_transfer', trim(p_bank_reference), trim(p_customer_name), lower(trim(p_customer_email)),
      trim(p_category_code), nullif(trim(p_membership_tier), ''), 'succeeded',
      p_amount_usd_text::numeric(20, 6), 'USD', 1,
      p_amount_usd_text::numeric(20, 6), p_amount_usd_text::numeric(20, 6), transfer_occurred_at, transfer_occurred_on,
      duplicate_fp, trim(p_reason), actor
    ) returning * into new_payment;
  exception when unique_violation then
    raise exception 'A manual bank transfer with this reference already exists';
  end;

  return new_payment;
end;
$$;

revoke all on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Product-mapping, local-correction, Finance-exception, and FX-conversion
-- workflow RPCs, plus the payment-duplicate-group workflow. Several of these
-- write public.financial_corrections / public.review_flags /
-- public.review_flag_resolutions, created by
-- 20270101000300_finance_targets_reports.sql (a later-numbered migration in
-- this same clean-slate set). PL/pgSQL bodies are late-bound, so this is safe:
-- Postgres does not resolve the tables/columns referenced inside a function
-- body until the function is actually called, only at CREATE FUNCTION time it
-- validates syntax. All final bodies below are copied verbatim from the last
-- migration that touched each one.
-- ---------------------------------------------------------------------------

-- Retired write path (see product_mappings RLS above): this function still
-- exists so historical behavior is documented and callable by service_role,
-- but EXECUTE is not granted to authenticated -- matches
-- 20260824150000_retire_b2c_product_mapping_requirement.sql exactly.
create or replace function public.apply_stripe_product_mapping(
  p_external_product_id text,
  p_internal_product_code text,
  p_internal_product_name text,
  p_category_code text,
  p_membership_tier text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_mapping public.product_mappings%rowtype;
  previous_mapping public.product_mappings%rowtype;
  target_product_id uuid;
  target_payment public.b2c_payments%rowtype;
  affected_payment_count integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can map a Stripe product locally';
  end if;
  if char_length(trim(p_external_product_id)) = 0
    or char_length(trim(p_internal_product_code)) = 0
    or char_length(trim(p_internal_product_name)) = 0
    or char_length(trim(p_category_code)) = 0
    or char_length(trim(p_reason)) = 0 then
    raise exception 'Stripe product, internal product, category, and audit reason are required';
  end if;
  if trim(p_internal_product_code) !~ '^[a-z0-9][a-z0-9_-]*$'
    or trim(p_category_code) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Internal product and category codes must use lowercase letters, numbers, hyphens, or underscores';
  end if;

  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  insert into public.products (internal_code, name)
  values (trim(p_internal_product_code), trim(p_internal_product_name))
  on conflict (internal_code) do update
    set name = excluded.name,
        active = true
  returning id into target_product_id;

  select * into previous_mapping
  from public.product_mappings
  where source_system = 'stripe'
    and external_product_id = trim(p_external_product_id)
  for update;

  insert into public.product_mappings (
    source_system, external_product_id, product_id, category_code,
    membership_tier, created_by, updated_by
  ) values (
    'stripe', trim(p_external_product_id), target_product_id,
    trim(p_category_code), nullif(trim(p_membership_tier), ''), auth.uid(), auth.uid()
  ) on conflict (source_system, external_product_id) do update set
    product_id = excluded.product_id,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    updated_by = auth.uid()
  returning * into target_mapping;

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'product_mapping', target_mapping.id, 'classification',
    case when previous_mapping.id is null then '{}'::jsonb else jsonb_build_object(
      'external_product_id', previous_mapping.external_product_id,
      'product_id', previous_mapping.product_id,
      'category_code', previous_mapping.category_code,
      'membership_tier', previous_mapping.membership_tier
    ) end,
    jsonb_build_object(
      'external_product_id', target_mapping.external_product_id,
      'product_id', target_mapping.product_id,
      'category_code', target_mapping.category_code,
      'membership_tier', target_mapping.membership_tier
    ),
    trim(p_reason), current_date
  );

  for target_payment in
    select * from public.b2c_payments
    where source_system = 'stripe'
      and source_metadata ->> 'product_reference' = trim(p_external_product_id)
    for update
  loop
    update public.b2c_payments
    set product_mapping_id = target_mapping.id,
        category_code = target_mapping.category_code,
        membership_tier = target_mapping.membership_tier,
        duplicate_fingerprint = encode(digest(
          coalesce(lower(target_payment.customer_email::text), 'missing-email:' || coalesce(target_payment.provider_transaction_id, target_payment.id::text))
          || '|' || target_payment.amount_usd::text
          || '|' || lower(target_mapping.category_code)
          || '|' || target_payment.occurred_on::text,
          'sha256'
        ), 'hex')
    where id = target_payment.id;

    insert into public.financial_corrections (
      target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
    ) values (
      'b2c_payment', target_payment.id, 'classification',
      jsonb_build_object('product_mapping_id', target_payment.product_mapping_id, 'category_code', target_payment.category_code, 'membership_tier', target_payment.membership_tier),
      jsonb_build_object('product_mapping_id', target_mapping.id, 'category_code', target_mapping.category_code, 'membership_tier', target_mapping.membership_tier),
      trim(p_reason), target_payment.occurred_on
    );
    affected_payment_count := affected_payment_count + 1;
  end loop;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select flag.id, 'resolved', trim(p_reason)
  from public.review_flags flag
  join public.b2c_payments payment on payment.id = flag.source_record_id
  where flag.source_area = 'b2c_payment'
    and flag.flag_type = 'unmapped_product'
    and flag.status = 'open'
    and payment.source_system = 'stripe'
    and payment.source_metadata ->> 'product_reference' = trim(p_external_product_id)
  on conflict (flag_id) do nothing;

  return target_mapping.id;
end;
$$;

create or replace function public.apply_b2c_product_mapping(
  p_source_system text,
  p_external_product_id text,
  p_internal_product_code text,
  p_internal_product_name text,
  p_category_code text,
  p_membership_tier text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_mapping public.product_mappings%rowtype;
  previous_mapping public.product_mappings%rowtype;
  target_product_id uuid;
  target_payment public.b2c_payments%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can map a B2C provider product locally';
  end if;
  if p_source_system = 'stripe' then
    return public.apply_stripe_product_mapping(p_external_product_id, p_internal_product_code, p_internal_product_name, p_category_code, p_membership_tier, p_reason);
  end if;
  if p_source_system <> 'tap' then
    raise exception 'Unsupported B2C source system';
  end if;
  if char_length(trim(p_external_product_id)) = 0
    or char_length(trim(p_internal_product_code)) = 0
    or char_length(trim(p_internal_product_name)) = 0
    or char_length(trim(p_category_code)) = 0
    or char_length(trim(p_reason)) = 0 then
    raise exception 'Tap product, internal product, category, and audit reason are required';
  end if;
  if trim(p_internal_product_code) !~ '^[a-z0-9][a-z0-9_-]*$'
    or trim(p_category_code) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Internal product and category codes must use lowercase letters, numbers, hyphens, or underscores';
  end if;

  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  insert into public.products (internal_code, name)
  values (trim(p_internal_product_code), trim(p_internal_product_name))
  on conflict (internal_code) do update set name = excluded.name, active = true
  returning id into target_product_id;

  select * into previous_mapping from public.product_mappings
  where source_system = 'tap' and external_product_id = trim(p_external_product_id)
  for update;

  insert into public.product_mappings (
    source_system, external_product_id, product_id, category_code, membership_tier, created_by, updated_by
  ) values (
    'tap', trim(p_external_product_id), target_product_id, trim(p_category_code), nullif(trim(p_membership_tier), ''), auth.uid(), auth.uid()
  ) on conflict (source_system, external_product_id) do update set
    product_id = excluded.product_id,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    updated_by = auth.uid()
  returning * into target_mapping;

  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
  values (
    'product_mapping', target_mapping.id, 'classification',
    case when previous_mapping.id is null then '{}'::jsonb else jsonb_build_object('external_product_id', previous_mapping.external_product_id, 'product_id', previous_mapping.product_id, 'category_code', previous_mapping.category_code, 'membership_tier', previous_mapping.membership_tier) end,
    jsonb_build_object('source_system', 'tap', 'external_product_id', target_mapping.external_product_id, 'product_id', target_mapping.product_id, 'category_code', target_mapping.category_code, 'membership_tier', target_mapping.membership_tier),
    trim(p_reason), current_date
  );

  for target_payment in
    select * from public.b2c_payments
    where source_system = 'tap' and source_metadata ->> 'product_reference' = trim(p_external_product_id)
    for update
  loop
    update public.b2c_payments set
      product_mapping_id = target_mapping.id,
      category_code = target_mapping.category_code,
      membership_tier = target_mapping.membership_tier,
      duplicate_fingerprint = encode(digest(
        coalesce(lower(target_payment.customer_email::text), 'missing-email:' || coalesce(target_payment.provider_transaction_id, target_payment.id::text))
        || '|' || target_payment.amount_usd::text
        || '|' || lower(target_mapping.category_code)
        || '|' || target_payment.occurred_on::text,
        'sha256'
      ), 'hex')
    where id = target_payment.id;

    insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
    values (
      'b2c_payment', target_payment.id, 'classification',
      jsonb_build_object('product_mapping_id', target_payment.product_mapping_id, 'category_code', target_payment.category_code, 'membership_tier', target_payment.membership_tier),
      jsonb_build_object('product_mapping_id', target_mapping.id, 'category_code', target_mapping.category_code, 'membership_tier', target_mapping.membership_tier),
      trim(p_reason), target_payment.occurred_on
    );
  end loop;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select flag.id, 'resolved', trim(p_reason)
  from public.review_flags flag
  join public.b2c_payments payment on payment.id = flag.source_record_id
  where flag.source_area = 'b2c_payment' and flag.flag_type = 'unmapped_product' and flag.status = 'open'
    and payment.source_system = 'tap' and payment.source_metadata ->> 'product_reference' = trim(p_external_product_id)
  on conflict (flag_id) do nothing;

  return target_mapping.id;
end;
$$;

revoke all on function public.apply_stripe_product_mapping(text, text, text, text, text, text) from public, authenticated;
revoke all on function public.apply_b2c_product_mapping(text, text, text, text, text, text, text) from public, authenticated;

-- Local correction workflow: still live (only the product-mapping-specific
-- write path above is retired). Final body from
-- 20260824151000_preserve_retired_unmapped_product_flag_history.sql -- no
-- longer resolves an `unmapped_product` flag, since that is no longer a
-- reporting blocker.
create or replace function public.apply_b2c_payment_local_correction(
  p_payment_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_category_code text,
  p_membership_tier text,
  p_local_amount_usd numeric(20, 6),
  p_local_occurred_on date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  prior_override public.b2c_payment_local_overrides%rowtype;
  effective_customer_name text;
  effective_customer_email citext;
  effective_customer_phone text;
  effective_category_code text;
  effective_membership_tier text;
  effective_amount_usd numeric(20, 6);
  effective_occurred_on date;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a local B2C correction';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A correction reason must be between 3 and 1000 characters';
  end if;
  if p_customer_name is null and p_customer_email is null and p_customer_phone is null
    and p_category_code is null and p_membership_tier is null
    and p_local_amount_usd is null and p_local_occurred_on is null then
    raise exception 'Enter at least one verified local correction';
  end if;
  if p_customer_name is not null and char_length(trim(p_customer_name)) not between 1 and 200 then
    raise exception 'Customer name must be between 1 and 200 characters';
  end if;
  if p_customer_email is not null and trim(p_customer_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid customer email';
  end if;
  if p_customer_phone is not null and char_length(trim(p_customer_phone)) not between 5 and 40 then
    raise exception 'Customer mobile must be between 5 and 40 characters';
  end if;
  if p_category_code is not null and lower(trim(p_category_code)) !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'Category must use lowercase letters, numbers, hyphens, or underscores';
  end if;
  if p_membership_tier is not null and char_length(trim(p_membership_tier)) not between 1 and 100 then
    raise exception 'Membership tier must be between 1 and 100 characters';
  end if;
  if p_local_amount_usd is not null and p_local_amount_usd <= 0 then
    raise exception 'Local USD amount must be greater than zero';
  end if;

  -- Keep the workflow mutex ahead of the strong payment/override row locks.
  -- The override trigger reacquires it reentrantly in this transaction.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_payment
  from public.b2c_payments
  where id = p_payment_id
  for update;
  if not found then
    raise exception 'The B2C payment is unavailable';
  end if;

  select * into prior_override
  from public.b2c_payment_local_overrides
  where payment_id = p_payment_id
  for update;

  effective_customer_name := coalesce(nullif(trim(p_customer_name), ''), prior_override.customer_name, target_payment.customer_name);
  effective_customer_email := coalesce(nullif(lower(trim(p_customer_email)), ''), prior_override.customer_email, target_payment.customer_email);
  effective_customer_phone := coalesce(nullif(trim(p_customer_phone), ''), prior_override.customer_phone, target_payment.customer_phone);
  effective_category_code := coalesce(nullif(lower(trim(p_category_code)), ''), prior_override.category_code, target_payment.category_code);
  effective_membership_tier := coalesce(nullif(trim(p_membership_tier), ''), prior_override.membership_tier, target_payment.membership_tier);
  effective_amount_usd := coalesce(p_local_amount_usd, prior_override.local_amount_usd, target_payment.amount_usd);
  effective_occurred_on := coalesce(p_local_occurred_on, prior_override.local_occurred_on, target_payment.occurred_on);

  if effective_customer_name is not distinct from coalesce(prior_override.customer_name, target_payment.customer_name)
    and effective_customer_email is not distinct from coalesce(prior_override.customer_email, target_payment.customer_email)
    and effective_customer_phone is not distinct from coalesce(prior_override.customer_phone, target_payment.customer_phone)
    and effective_category_code is not distinct from coalesce(prior_override.category_code, target_payment.category_code)
    and effective_membership_tier is not distinct from coalesce(prior_override.membership_tier, target_payment.membership_tier)
    and effective_amount_usd is not distinct from coalesce(prior_override.local_amount_usd, target_payment.amount_usd)
    and effective_occurred_on is not distinct from coalesce(prior_override.local_occurred_on, target_payment.occurred_on) then
    raise exception 'The submitted values do not change this payment';
  end if;

  insert into public.b2c_payment_local_overrides (
    payment_id, customer_name, customer_email, customer_phone, category_code,
    membership_tier, local_amount_usd, local_occurred_on, created_by, updated_by
  ) values (
    p_payment_id,
    case when p_customer_name is null then prior_override.customer_name else effective_customer_name end,
    case when p_customer_email is null then prior_override.customer_email else effective_customer_email end,
    case when p_customer_phone is null then prior_override.customer_phone else effective_customer_phone end,
    case when p_category_code is null then prior_override.category_code else effective_category_code end,
    case when p_membership_tier is null then prior_override.membership_tier else effective_membership_tier end,
    case when p_local_amount_usd is null then prior_override.local_amount_usd else effective_amount_usd end,
    case when p_local_occurred_on is null then prior_override.local_occurred_on else effective_occurred_on end,
    auth.uid(), auth.uid()
  ) on conflict (payment_id) do update set
    customer_name = excluded.customer_name,
    customer_email = excluded.customer_email,
    customer_phone = excluded.customer_phone,
    category_code = excluded.category_code,
    membership_tier = excluded.membership_tier,
    local_amount_usd = excluded.local_amount_usd,
    local_occurred_on = excluded.local_occurred_on,
    updated_by = auth.uid();

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    jsonb_build_object(
      'customer_name', coalesce(prior_override.customer_name, target_payment.customer_name),
      'customer_email', coalesce(prior_override.customer_email, target_payment.customer_email),
      'customer_phone', coalesce(prior_override.customer_phone, target_payment.customer_phone),
      'category_code', coalesce(prior_override.category_code, target_payment.category_code),
      'membership_tier', coalesce(prior_override.membership_tier, target_payment.membership_tier),
      'amount_usd', coalesce(prior_override.local_amount_usd, target_payment.amount_usd),
      'occurred_on', coalesce(prior_override.local_occurred_on, target_payment.occurred_on)
    ),
    jsonb_build_object(
      'customer_name', effective_customer_name,
      'customer_email', effective_customer_email,
      'customer_phone', effective_customer_phone,
      'category_code', effective_category_code,
      'membership_tier', effective_membership_tier,
      'amount_usd', effective_amount_usd,
      'occurred_on', effective_occurred_on
    ),
    trim(p_reason), effective_occurred_on
  );

  if p_customer_email is not null then
    insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
    select id, 'resolved', trim(p_reason)
    from public.review_flags
    where source_area = 'b2c_payment'
      and source_record_id = p_payment_id
      and flag_type = 'needs_follow_up'
      and status = 'open'
      and reason ~* 'missing a valid customer email'
    on conflict (flag_id) do nothing;
  end if;

end;
$$;

revoke all on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text) from public;
grant execute on function public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text) to authenticated;

-- Finance exception workflow: FINAL body from
-- 20260824150000_retire_b2c_product_mapping_requirement.sql -- an unmapped
-- category is no longer a reporting blocker, but FX still cannot be bypassed.
create or replace function public.include_b2c_payment_with_finance_exception(
  p_payment_id uuid, p_reason text, p_confirmed_provider_transaction boolean, p_confirmed_no_known_duplicate boolean
)
returns void language plpgsql security definer set search_path = public as $$
declare target_payment public.b2c_payments%rowtype; local_override public.b2c_payment_local_overrides%rowtype; fx_conversion public.b2c_payment_fx_conversions%rowtype; effective_category_code text; effective_amount_usd numeric(20, 6); effective_occurred_on date; prior_decision text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can include a B2C payment by Finance exception'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'A Finance exception reason must be between 3 and 1000 characters'; end if;
  if p_confirmed_provider_transaction is not true or p_confirmed_no_known_duplicate is not true then raise exception 'Confirm the provider transaction and duplicate review before including this payment'; end if;
  select * into target_payment from public.b2c_payments where id = p_payment_id for update;
  if not found then raise exception 'The B2C payment is unavailable'; end if;
  if target_payment.payment_status <> 'succeeded' then raise exception 'Only a succeeded provider payment can be included by Finance exception'; end if;
  if target_payment.provider_transaction_id is null or (select count(*) from public.b2c_payments where provider_transaction_id = target_payment.provider_transaction_id) <> 1 then raise exception 'A Finance exception requires the exact unique provider transaction ID'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'possible_duplicate') then raise exception 'Resolve the possible duplicate before using a Finance exception'; end if;
  if exists (select 1 from public.review_flags where source_area = 'b2c_payment' and source_record_id = p_payment_id and status = 'open' and flag_type = 'needs_follow_up' and reason !~* 'missing a valid customer email') then raise exception 'This payment has another unresolved source issue that cannot be bypassed'; end if;
  select * into local_override from public.b2c_payment_local_overrides where payment_id = p_payment_id;
  select * into fx_conversion from public.b2c_payment_fx_conversions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  effective_category_code := coalesce(local_override.category_code, target_payment.category_code);
  -- A foreign source can use only its append-only Finance conversion. This
  -- deliberately ignores any historical generic local USD overlay.
  effective_amount_usd := case
    when target_payment.original_currency <> 'USD' then fx_conversion.amount_usd
    else coalesce(local_override.local_amount_usd, target_payment.amount_usd)
  end;
  effective_occurred_on := coalesce(local_override.local_occurred_on, target_payment.occurred_on);
  if effective_amount_usd is null or effective_amount_usd <= 0 or effective_occurred_on is null then raise exception 'Record a Finance-approved USD conversion and verified business date before using a Finance exception'; end if;
  select decision into prior_decision from public.b2c_payment_finance_exception_decisions where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  insert into public.b2c_payment_finance_exception_decisions (payment_id, decision, reason, confirmed_provider_transaction, confirmed_no_known_duplicate, created_by) values (p_payment_id, 'include', trim(p_reason), true, true, auth.uid());
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on) values ('b2c_payment', p_payment_id, 'other', jsonb_build_object('finance_exception_decision', coalesce(prior_decision, 'none')), jsonb_build_object('finance_exception_decision', 'include', 'provider_transaction_id', target_payment.provider_transaction_id, 'category_code', effective_category_code, 'amount_usd', effective_amount_usd, 'occurred_on', effective_occurred_on, 'missing_source_fields_remain_visible', true), trim(p_reason), effective_occurred_on);
end;
$$;

revoke all on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) from public;
grant execute on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) to authenticated;

-- FX conversion workflow: append-only, RPC-only writes into
-- b2c_payment_fx_conversions / b2c_refund_fx_conversions (see the revoked
-- direct-insert grants on those tables above). Final bodies, unchanged since
-- 20260813190000_b2c_manual_fx_conversions.sql.
create or replace function public.record_b2c_payment_fx_conversion(
  p_payment_id uuid,
  p_exchange_rate_to_usd numeric(20, 10),
  p_conversion_source text,
  p_effective_on date,
  p_reason text
)
returns numeric(20, 6)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_payment public.b2c_payments%rowtype;
  prior_conversion public.b2c_payment_fx_conversions%rowtype;
  converted_amount numeric(20, 6);
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can record a B2C FX conversion';
  end if;
  if p_exchange_rate_to_usd is null or p_exchange_rate_to_usd <= 0 then
    raise exception 'Exchange rate to USD must be greater than zero';
  end if;
  if p_effective_on is null then
    raise exception 'A conversion effective date is required';
  end if;
  if char_length(trim(coalesce(p_conversion_source, ''))) not between 3 and 300 then
    raise exception 'A conversion source must be between 3 and 300 characters';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'A conversion reason must be between 3 and 1000 characters';
  end if;

  select * into target_payment from public.b2c_payments where id = p_payment_id for update;
  if not found then raise exception 'The B2C payment is unavailable'; end if;
  if target_payment.original_currency = 'USD' then
    raise exception 'This payment is already a USD source payment and does not require an FX conversion';
  end if;
  if target_payment.payment_status <> 'succeeded' then
    raise exception 'Only a succeeded provider payment can receive a Finance FX conversion';
  end if;

  select * into prior_conversion from public.b2c_payment_fx_conversions
  where payment_id = p_payment_id order by created_at desc, id desc limit 1;
  converted_amount := round(target_payment.original_amount * p_exchange_rate_to_usd, 6);

  insert into public.b2c_payment_fx_conversions (
    payment_id, original_amount, original_currency, exchange_rate_to_usd,
    amount_usd, effective_on, conversion_source, reason, created_by
  ) values (
    p_payment_id, target_payment.original_amount, target_payment.original_currency,
    p_exchange_rate_to_usd, converted_amount, p_effective_on,
    trim(p_conversion_source), trim(p_reason), auth.uid()
  );

  insert into public.financial_corrections (
    target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on
  ) values (
    'b2c_payment', p_payment_id, 'other',
    case when prior_conversion.id is null then '{}'::jsonb else jsonb_build_object('amount_usd', prior_conversion.amount_usd, 'exchange_rate_to_usd', prior_conversion.exchange_rate_to_usd, 'conversion_source', prior_conversion.conversion_source) end,
    jsonb_build_object('original_amount', target_payment.original_amount, 'original_currency', target_payment.original_currency, 'amount_usd', converted_amount, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'conversion_source', trim(p_conversion_source)),
    trim(p_reason), p_effective_on
  );

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', trim(p_reason) from public.review_flags
  where source_area = 'b2c_payment' and source_record_id = p_payment_id
    and flag_type = 'needs_fx_review' and status = 'open'
  on conflict (flag_id) do nothing;
  return converted_amount;
end;
$$;

create or replace function public.record_b2c_refund_fx_conversion(
  p_refund_id uuid,
  p_exchange_rate_to_usd numeric(20, 10),
  p_conversion_source text,
  p_effective_on date,
  p_reason text
)
returns numeric(20, 6)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_refund public.b2c_refunds%rowtype;
  original_payment public.b2c_payments%rowtype;
  prior_conversion public.b2c_refund_fx_conversions%rowtype;
  payment_amount_usd numeric(20, 6);
  other_refunds_usd numeric(20, 6);
  converted_amount numeric(20, 6);
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Only an authenticated administrator can record a B2C refund FX conversion'; end if;
  if p_exchange_rate_to_usd is null or p_exchange_rate_to_usd <= 0 then raise exception 'Exchange rate to USD must be greater than zero'; end if;
  if p_effective_on is null then raise exception 'A conversion effective date is required'; end if;
  if char_length(trim(coalesce(p_conversion_source, ''))) not between 3 and 300 then raise exception 'A conversion source must be between 3 and 300 characters'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'A conversion reason must be between 3 and 1000 characters'; end if;

  select * into target_refund from public.b2c_refunds where id = p_refund_id for update;
  if not found then raise exception 'The B2C refund is unavailable'; end if;
  if target_refund.original_currency = 'USD' then raise exception 'This refund is already a USD source refund and does not require an FX conversion'; end if;
  select * into original_payment from public.b2c_payments where id = target_refund.payment_id for update;
  select case
    when original_payment.original_currency <> 'USD' then payment_conversion.amount_usd
    else coalesce(local_override.local_amount_usd, original_payment.amount_usd)
  end
    into payment_amount_usd
  from public.b2c_payments ignored
  left join public.b2c_payment_local_overrides local_override on local_override.payment_id = ignored.id
  left join lateral (select amount_usd from public.b2c_payment_fx_conversions where payment_id = ignored.id order by created_at desc, id desc limit 1) payment_conversion on true
  where ignored.id = original_payment.id;
  if payment_amount_usd is null then raise exception 'Record the original payment FX conversion before converting this refund'; end if;

  converted_amount := round(target_refund.original_amount * p_exchange_rate_to_usd, 6);
  select coalesce(sum(coalesce(refund_conversion.amount_usd, other_refund.amount_usd)), 0) into other_refunds_usd
  from public.b2c_refunds other_refund
  left join lateral (select amount_usd from public.b2c_refund_fx_conversions where refund_id = other_refund.id order by created_at desc, id desc limit 1) refund_conversion on true
  where other_refund.payment_id = target_refund.payment_id and other_refund.id <> p_refund_id;
  if other_refunds_usd + converted_amount > payment_amount_usd then raise exception 'Refund total cannot exceed the converted original payment amount'; end if;

  select * into prior_conversion from public.b2c_refund_fx_conversions where refund_id = p_refund_id order by created_at desc, id desc limit 1;
  insert into public.b2c_refund_fx_conversions (refund_id, original_amount, original_currency, exchange_rate_to_usd, amount_usd, effective_on, conversion_source, reason, created_by)
  values (p_refund_id, target_refund.original_amount, target_refund.original_currency, p_exchange_rate_to_usd, converted_amount, p_effective_on, trim(p_conversion_source), trim(p_reason), auth.uid());
  insert into public.financial_corrections (target_area, target_record_id, correction_type, before_value, after_value, reason, effective_on)
  values ('b2c_refund', p_refund_id, 'other', case when prior_conversion.id is null then '{}'::jsonb else jsonb_build_object('amount_usd', prior_conversion.amount_usd, 'exchange_rate_to_usd', prior_conversion.exchange_rate_to_usd, 'conversion_source', prior_conversion.conversion_source) end, jsonb_build_object('original_amount', target_refund.original_amount, 'original_currency', target_refund.original_currency, 'amount_usd', converted_amount, 'exchange_rate_to_usd', p_exchange_rate_to_usd, 'conversion_source', trim(p_conversion_source)), trim(p_reason), p_effective_on);
  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  select id, 'resolved', trim(p_reason) from public.review_flags where source_area = 'b2c_refund' and source_record_id = p_refund_id and flag_type = 'needs_fx_review' and status = 'open' on conflict (flag_id) do nothing;
  return converted_amount;
end;
$$;

revoke all on function public.record_b2c_payment_fx_conversion(uuid, numeric, text, date, text) from public;
grant execute on function public.record_b2c_payment_fx_conversion(uuid, numeric, text, date, text) to authenticated;
revoke all on function public.record_b2c_refund_fx_conversion(uuid, numeric, text, date, text) from public;
grant execute on function public.record_b2c_refund_fx_conversion(uuid, numeric, text, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Payment-duplicate-group workflow: constructs and resolves
-- b2c_payment_duplicate_groups / b2c_payment_duplicate_group_members from the
-- generic 48-hour content fingerprint, and flags/resolves the corresponding
-- public.review_flags rows. Final bodies, unchanged since
-- 20260820111000_b2c_payment_duplicate_groups.sql.
-- ---------------------------------------------------------------------------

create or replace function public.get_effective_b2c_duplicate_facts(p_payment_id uuid)
returns table (
  payment_id uuid,
  customer_email text,
  comparison_amount numeric(20, 6),
  category_code text,
  occurred_at timestamptz,
  occurred_on date,
  fingerprint text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id,
    lower(trim(coalesce(o.customer_email, p.customer_email)::text)),
    coalesce(o.local_amount_usd, p.amount_usd),
    lower(trim(coalesce(o.category_code, p.category_code))),
    p.occurred_at,
    coalesce(o.local_occurred_on, p.occurred_on),
    encode(extensions.digest(
      lower(trim(coalesce(o.customer_email, p.customer_email)::text)) || '|' ||
      'USD|' ||
      coalesce(o.local_amount_usd, p.amount_usd)::numeric(20, 6)::text || '|' ||
      lower(trim(coalesce(o.category_code, p.category_code))) || '|' ||
      coalesce(o.local_occurred_on, p.occurred_on)::text,
      'sha256'
    ), 'hex')
  from public.b2c_payments p
  left join public.b2c_payment_local_overrides o on o.payment_id = p.id
  where p.id = p_payment_id
    and p.payment_status = 'succeeded'
    and coalesce(o.customer_email, p.customer_email) is not null
    and coalesce(o.local_amount_usd, p.amount_usd) is not null
    and coalesce(o.category_code, p.category_code) is not null
    and coalesce(o.local_occurred_on, p.occurred_on) is not null;
$$;

revoke all on function public.get_effective_b2c_duplicate_facts(uuid) from public, anon, authenticated;

create or replace function public.open_b2c_payment_duplicate_group(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  candidate_ids uuid[];
  open_group_id uuid;
  existing_group_id uuid;
  latest_resolved_group_id uuid;
  latest_resolved_member_ids uuid[];
begin
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif auth.uid() is null and auth.role() is null then
    null;
  elsif auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator or trusted database session can create B2C payment duplicate groups';
  end if;

  -- One workflow mutex serializes all group/member/flag decisions. This
  -- constructor never explicitly locks source rows; writers that need a
  -- conflicting source FOR UPDATE take this mutex before that source lock.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  -- Preserve the evidence set captured when this case opened even if a local
  -- correction changes the payment while Finance is reviewing it.
  select duplicate_group.id into existing_group_id
  from public.b2c_payment_duplicate_group_members member
  join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
  where member.payment_id = p_payment_id
    and duplicate_group.status = 'open'
  order by duplicate_group.created_at, duplicate_group.id
  limit 1;
  if found then
    return existing_group_id;
  end if;

  select * into target
  from public.get_effective_b2c_duplicate_facts(p_payment_id);
  if not found then
    return null;
  end if;

  with candidate_facts as (
    select facts.*
    from public.b2c_payments payment
    cross join lateral public.get_effective_b2c_duplicate_facts(payment.id) facts
  ), eligible_candidates as (
    select candidate.payment_id
    from candidate_facts candidate
    where candidate.customer_email = target.customer_email
      and candidate.comparison_amount = target.comparison_amount
      and candidate.category_code = target.category_code
      and candidate.occurred_on = target.occurred_on
      and candidate.occurred_at between target.occurred_at - interval '48 hours' and target.occurred_at + interval '48 hours'
      and not exists (
        select 1
        from public.b2c_payment_duplicate_group_members prior_member
        join public.b2c_payment_duplicate_groups prior_group on prior_group.id = prior_member.group_id
        where prior_member.payment_id = candidate.payment_id
          and prior_group.status = 'resolved'
          and prior_member.decision = 'exclude'
      )
  )
  select array_agg(payment_id order by payment_id) into candidate_ids
  from (select distinct payment_id from eligible_candidates) distinct_candidates;

  if coalesce(cardinality(candidate_ids), 0) < 2 then
    return null;
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = any(candidate_ids)
      and duplicate_group.status = 'open'
      and duplicate_group.fingerprint <> target.fingerprint
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;

  select duplicate_group.id into open_group_id
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = target.fingerprint
    and duplicate_group.status = 'open'
  for update;

  if found then
    if exists (
      select 1
      from public.b2c_payment_duplicate_group_members member
      join public.b2c_payment_duplicate_groups other_group on other_group.id = member.group_id
      where member.payment_id = any(candidate_ids)
        and other_group.status = 'open'
        and other_group.id <> open_group_id
    ) then
      raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
    end if;

    insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
    select open_group_id, candidate_id
    from unnest(candidate_ids) candidate_id
    on conflict (group_id, payment_id) do nothing;

    insert into public.review_flags (
      source_area, source_record_id, flag_type, status, priority, reason, created_by
    )
    select
      'b2c_payment', candidate_id, 'possible_duplicate', 'open', 2,
      'Another succeeded B2C payment has the same effective customer email, USD amount, category, and business date within 48 hours. It is excluded from financial totals pending Admin review.',
      auth.uid()
    from unnest(candidate_ids) candidate_id
    on conflict (source_area, source_record_id, flag_type, status) do update set
      priority = excluded.priority,
      reason = excluded.reason,
      updated_at = timezone('utc', now());

    return open_group_id;
  end if;

  select duplicate_group.id,
    array(
      select member.payment_id
      from public.b2c_payment_duplicate_group_members member
      where member.group_id = duplicate_group.id
      order by member.payment_id
    )
  into latest_resolved_group_id, latest_resolved_member_ids
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.fingerprint = target.fingerprint
    and duplicate_group.status = 'resolved'
  order by duplicate_group.resolved_at desc, duplicate_group.id desc
  limit 1;

  if found and latest_resolved_member_ids = candidate_ids then
    return null;
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = any(candidate_ids)
      and duplicate_group.status = 'open'
  ) then
    raise exception 'A payment cannot belong to more than one open B2C payment duplicate group';
  end if;

  insert into public.b2c_payment_duplicate_groups (fingerprint, detection_reason)
  values (
    target.fingerprint,
    'Succeeded B2C payments share the same effective customer email, USD amount, category, and business date within 48 hours.'
  )
  returning id into open_group_id;

  insert into public.b2c_payment_duplicate_group_members (group_id, payment_id)
  select open_group_id, candidate_id
  from unnest(candidate_ids) candidate_id;

  insert into public.review_flags (
    source_area, source_record_id, flag_type, status, priority, reason, created_by
  )
  select
    'b2c_payment', candidate_id, 'possible_duplicate', 'open', 2,
    'Another succeeded B2C payment has the same effective customer email, USD amount, category, and business date within 48 hours. It is excluded from financial totals pending Admin review.',
    auth.uid()
  from unnest(candidate_ids) candidate_id
  on conflict (source_area, source_record_id, flag_type, status) do update set
    priority = excluded.priority,
    reason = excluded.reason,
    updated_at = timezone('utc', now());

  return open_group_id;
end;
$$;

revoke all on function public.open_b2c_payment_duplicate_group(uuid) from public, anon;
grant execute on function public.open_b2c_payment_duplicate_group(uuid) to authenticated, service_role;

create or replace function public.open_b2c_payment_duplicate_group_after_payment_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.open_b2c_payment_duplicate_group(new.id);
  return new;
end;
$$;

create or replace function public.open_b2c_payment_duplicate_group_after_override_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.open_b2c_payment_duplicate_group(new.payment_id);
  return new;
end;
$$;

revoke all on function public.open_b2c_payment_duplicate_group_after_payment_write() from public;
revoke all on function public.open_b2c_payment_duplicate_group_after_override_write() from public;

create trigger open_b2c_payment_duplicate_group_after_payment_write
  after insert or update of payment_status, customer_email, category_code, amount_usd, occurred_at, occurred_on
  on public.b2c_payments
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_payment_write();

create trigger open_b2c_payment_duplicate_group_after_override_write
  after insert or update of customer_email, category_code, local_amount_usd, local_occurred_on
  on public.b2c_payment_local_overrides
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_override_write();

create or replace function public.resolve_b2c_payment_duplicate_group(
  p_group_id uuid,
  p_decision text,
  p_canonical_payment_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group public.b2c_payment_duplicate_groups%rowtype;
  member_record record;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can resolve B2C payment duplicate groups';
  end if;

  if p_decision is null or p_decision not in ('keep_all', 'keep_one') then
    raise exception 'Duplicate decisions must be keep_all or keep_one';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000
    or lower(trim(p_reason)) in ('n/a', 'na')
    or trim(p_reason) ~ '^[-—]+$' then
    raise exception 'A meaningful duplicate decision reason between 3 and 1000 characters is required';
  end if;

  if p_decision = 'keep_all' and p_canonical_payment_id is not null then
    raise exception 'A keep-all decision cannot select a canonical payment';
  end if;

  if p_decision = 'keep_one' and p_canonical_payment_id is null then
    raise exception 'A keep-one decision requires a canonical payment from this duplicate group';
  end if;

  -- The shared workflow mutex precedes every group/member/flag lock. Nested
  -- constructor calls are transaction-lock reentrant. FK checks may request
  -- KEY SHARE, so strong source-row writers also take this mutex first.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_group
  from public.b2c_payment_duplicate_groups duplicate_group
  where duplicate_group.id = p_group_id
  for update;

  if not found or target_group.status <> 'open' then
    raise exception 'This duplicate group is unavailable or already resolved';
  end if;

  perform 1
  from public.b2c_payment_duplicate_group_members member
  where member.group_id = p_group_id
  order by member.payment_id
  for update;

  if p_decision = 'keep_one' and not exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    where member.group_id = p_group_id
      and member.payment_id = p_canonical_payment_id
  ) then
    raise exception 'The selected canonical payment must belong to this duplicate group';
  end if;

  update public.b2c_payment_duplicate_group_members
  set decision = case
    when p_decision = 'keep_all' or payment_id = p_canonical_payment_id then 'include'
    else 'exclude'
  end
  where group_id = p_group_id and decision = 'pending';

  update public.b2c_payment_duplicate_groups
  set status = 'resolved',
      decision = p_decision,
      canonical_payment_id = case when p_decision = 'keep_one' then p_canonical_payment_id else null end,
      resolution_reason = trim(p_reason),
      resolved_by = auth.uid(),
      resolved_at = timezone('utc', now())
  where id = p_group_id and status = 'open';

  for member_record in
    select member.payment_id, member.decision
    from public.b2c_payment_duplicate_group_members member
    where member.group_id = p_group_id
    order by member.payment_id
  loop
    if not exists (
      select 1
      from public.b2c_payment_duplicate_group_members other_member
      join public.b2c_payment_duplicate_groups other_group on other_group.id = other_member.group_id
      where other_member.payment_id = member_record.payment_id
        and other_group.status = 'open'
    ) then
      insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
      select flag.id, 'resolved', trim(p_reason)
      from public.review_flags flag
      where flag.source_area = 'b2c_payment'
        and flag.source_record_id = member_record.payment_id
        and flag.flag_type = 'possible_duplicate'
        and flag.status = 'open'
      on conflict (flag_id) do nothing;
    end if;
  end loop;

  for member_record in
    select member.payment_id
    from public.b2c_payment_duplicate_group_members member
    where member.group_id = p_group_id
      and member.decision = 'include'
    order by member.payment_id
  loop
    perform public.open_b2c_payment_duplicate_group(member_record.payment_id);
  end loop;
end;
$$;

revoke all on function public.resolve_b2c_payment_duplicate_group(uuid, text, uuid, text) from public, anon;
grant execute on function public.resolve_b2c_payment_duplicate_group(uuid, text, uuid, text) to authenticated;

create or replace function public.dismiss_stale_b2c_possible_duplicate_flag(
  p_flag_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- public.review_flags does not exist yet when this migration is applied in
  -- isolation (it is created by 20270101000300_finance_targets_reports.sql,
  -- a later-numbered migration); `record` avoids resolving its row type at
  -- CREATE FUNCTION time, unlike `%rowtype`.
  target_flag record;
  current_group_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can dismiss a stale B2C possible-duplicate flag';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000
    or lower(trim(p_reason)) in ('n/a', 'na')
    or trim(p_reason) ~ '^[-—]+$' then
    raise exception 'A meaningful duplicate decision reason between 3 and 1000 characters is required';
  end if;

  -- Serialize before locking the flag; constructors use the same mutex before
  -- any group/member/flag write.
  perform pg_advisory_xact_lock(hashtext('b2c_payment_duplicate_workflow'));

  select * into target_flag
  from public.review_flags flag
  where flag.id = p_flag_id
    and flag.source_area = 'b2c_payment'
    and flag.flag_type = 'possible_duplicate'
    and flag.status = 'open'
  for update;

  if not found then
    raise exception 'The open B2C possible-duplicate flag is unavailable';
  end if;

  if exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = target_flag.source_record_id
      and duplicate_group.status = 'open'
  ) then
    raise exception 'This possible duplicate still has a current duplicate group';
  end if;

  current_group_id := public.open_b2c_payment_duplicate_group(target_flag.source_record_id);
  if current_group_id is not null then
    raise exception 'This possible duplicate still has a current duplicate group';
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  values (target_flag.id, 'dismissed', trim(p_reason));
end;
$$;

revoke all on function public.dismiss_stale_b2c_possible_duplicate_flag(uuid, text) from public, anon;
grant execute on function public.dismiss_stale_b2c_possible_duplicate_flag(uuid, text) to authenticated;

create or replace function public.get_b2c_payment_duplicate_reporting_states()
returns table (
  payment_id uuid,
  has_open_duplicate boolean,
  has_duplicate_exclusion boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select member.payment_id,
    bool_or(duplicate_group.status = 'open') as has_open_duplicate,
    bool_or(duplicate_group.status = 'resolved' and member.decision = 'exclude') as has_duplicate_exclusion
  from public.b2c_payment_duplicate_group_members member
  join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
  where auth.uid() is not null
    and public.is_approved_user()
  group by member.payment_id;
$$;

revoke all on function public.get_b2c_payment_duplicate_reporting_states() from public, anon;
grant execute on function public.get_b2c_payment_duplicate_reporting_states() to authenticated;

-- ---------------------------------------------------------------------------
-- Read-only Stripe evidence RPCs: expose a controlled, safe subset of
-- b2c_stripe_payment_details / b2c_stripe_refund_details to any approved user
-- without granting direct table access (those tables stay admin_read-only
-- above). Final bodies, unchanged since their introducing migrations.
-- ---------------------------------------------------------------------------

create or replace function public.get_b2c_stripe_payment_contact_fallbacks()
returns table (
  payment_id uuid,
  customer_name text,
  customer_name_label text,
  customer_email citext,
  customer_email_label text,
  customer_phone text,
  customer_phone_label text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;

  return query
  select
    details.payment_id,
    coalesce(details.payment_method_customer_name, details.customer_profile_name),
    case
      when details.payment_method_customer_name is not null then 'Stripe payment method'
      when details.customer_profile_name is not null then 'Stripe profile'
      else null
    end,
    coalesce(details.payment_method_customer_email, details.customer_profile_email),
    case
      when details.payment_method_customer_email is not null then 'Stripe payment method'
      when details.customer_profile_email is not null then 'Stripe profile'
      else null
    end,
    coalesce(details.payment_method_customer_phone, details.customer_profile_phone),
    case
      when details.payment_method_customer_phone is not null then 'Stripe payment method'
      when details.customer_profile_phone is not null then 'Stripe profile'
      else null
    end
  from public.b2c_stripe_payment_details as details;
end;
$$;

revoke all on function public.get_b2c_stripe_payment_contact_fallbacks() from public;
grant execute on function public.get_b2c_stripe_payment_contact_fallbacks() to authenticated;

create or replace function public.get_b2c_stripe_payment_evidence()
returns table (
  payment_id uuid,
  original_amount numeric,
  original_currency text,
  charge_refunded_amount numeric,
  charge_description text,
  seller_message text,
  cardholder_name text,
  settlement_gross_amount numeric,
  settlement_fee_amount numeric,
  settlement_fee_tax_amount numeric,
  settlement_net_amount numeric,
  settlement_currency text,
  settlement_exchange_rate numeric,
  refund_id uuid,
  refund_original_amount numeric,
  refund_original_currency text,
  refund_settlement_amount numeric,
  refund_settlement_currency text,
  refund_settlement_exchange_rate numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_approved_user() then
    raise exception 'Approved PLAYBOOK access is required';
  end if;

  return query
  select
    payment.id,
    payment.original_amount,
    payment.original_currency::text,
    details.charge_refunded_amount,
    details.charge_description,
    details.seller_message,
    details.cardholder_name,
    details.settlement_gross_amount,
    details.settlement_fee_amount,
    details.settlement_fee_tax_amount,
    details.settlement_net_amount,
    details.settlement_currency::text,
    details.settlement_exchange_rate,
    refund.id,
    refund.original_amount,
    refund.original_currency::text,
    refund_details.settlement_refund_amount,
    refund_details.settlement_currency::text,
    refund_details.settlement_exchange_rate
  from public.b2c_payments as payment
  left join public.b2c_stripe_payment_details as details on details.payment_id = payment.id
  left join public.b2c_refunds as refund on refund.payment_id = payment.id and refund.source_system = 'stripe'
  left join public.b2c_stripe_refund_details as refund_details on refund_details.refund_id = refund.id
  where payment.source_system = 'stripe';
end;
$$;

revoke all on function public.get_b2c_stripe_payment_evidence() from public;
grant execute on function public.get_b2c_stripe_payment_evidence() to authenticated;
