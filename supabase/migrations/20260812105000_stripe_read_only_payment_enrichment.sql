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

revoke all on function public.enforce_stripe_payment_details_source() from public;
revoke all on function public.get_b2c_stripe_payment_contact_fallbacks() from public;
grant execute on function public.get_b2c_stripe_payment_contact_fallbacks() to authenticated;
