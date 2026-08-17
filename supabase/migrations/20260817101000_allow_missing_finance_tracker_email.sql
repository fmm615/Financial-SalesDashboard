-- Finance approved some Payment Tracker rows with no customer email. Preserve
-- that fact as null rather than inventing an address, while retaining the
-- existing email requirement for every non-Finance B2C payment source.

alter table public.b2c_payments
  alter column customer_email drop not null;

alter table public.b2c_payments
  drop constraint if exists b2c_payments_customer_email_requirement_check,
  add constraint b2c_payments_customer_email_requirement_check
    check (customer_email is not null or source_system = 'finance_tracker');
