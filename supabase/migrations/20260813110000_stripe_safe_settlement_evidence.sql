-- Retains selected Stripe evidence for approved PLAYBOOK users. These are
-- source/audit values only: none feeds B2C reportability or financial totals.

alter table public.b2c_stripe_payment_details
  add column if not exists charge_description text,
  add column if not exists seller_message text,
  add column if not exists cardholder_name text,
  add column if not exists charge_refunded_amount numeric(20,6);

alter table public.b2c_stripe_payment_details
  drop constraint if exists b2c_stripe_payment_details_charge_evidence_lengths_check;

alter table public.b2c_stripe_payment_details
  add constraint b2c_stripe_payment_details_charge_evidence_lengths_check check (
    (charge_description is null or char_length(trim(charge_description)) between 1 and 2000)
    and (seller_message is null or char_length(trim(seller_message)) between 1 and 2000)
    and (cardholder_name is null or char_length(trim(cardholder_name)) between 1 and 200)
    and (charge_refunded_amount is null or charge_refunded_amount >= 0)
  );

create table if not exists public.b2c_stripe_refund_details (
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

drop trigger if exists set_b2c_stripe_refund_details_updated_at on public.b2c_stripe_refund_details;
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

drop trigger if exists enforce_b2c_stripe_refund_details_source on public.b2c_stripe_refund_details;
create trigger enforce_b2c_stripe_refund_details_source
  before insert or update of refund_id on public.b2c_stripe_refund_details
  for each row execute procedure public.enforce_stripe_refund_details_source();

alter table public.b2c_stripe_refund_details enable row level security;

drop policy if exists admin_read on public.b2c_stripe_refund_details;
create policy admin_read on public.b2c_stripe_refund_details
  for select to authenticated
  using (public.is_admin());

revoke all on public.b2c_stripe_refund_details from anon, authenticated;
grant select on public.b2c_stripe_refund_details to authenticated;

-- The general B2C ledger requires a controlled, read-only view of selected
-- evidence fields. This avoids exposing raw Stripe payloads or payment-method
-- data while allowing approved management users to inspect source traceability.
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

revoke all on function public.enforce_stripe_refund_details_source() from public;
revoke all on function public.get_b2c_stripe_payment_evidence() from public;
grant execute on function public.get_b2c_stripe_payment_evidence() to authenticated;
