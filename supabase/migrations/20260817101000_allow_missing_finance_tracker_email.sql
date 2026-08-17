-- Finance approved some Payment Tracker rows with no customer email. Preserve
-- that fact as null rather than inventing an address. Earlier Stripe source
-- records also intentionally retain missing email for review, so reportability
-- rules—not a table-wide contact rule—govern whether a payment is counted.

alter table public.b2c_payments
  alter column customer_email drop not null;

alter table public.b2c_payments
  drop constraint if exists b2c_payments_customer_email_requirement_check;
