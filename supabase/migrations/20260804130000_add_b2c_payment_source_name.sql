-- Keep the name supplied directly by the payment provider on each source row.
-- It is nullable because a provider may legitimately omit it; no name is inferred.
alter table public.b2c_payments
  add column if not exists customer_name text;

alter table public.b2c_payments
  drop constraint if exists b2c_payments_customer_name_length_check;

alter table public.b2c_payments
  add constraint b2c_payments_customer_name_length_check
  check (customer_name is null or char_length(customer_name) <= 200);
