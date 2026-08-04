-- A phone is optional source-traceability data. It is never used to classify,
-- deduplicate, or calculate a B2C financial record.
alter table public.b2c_payments
  add column customer_phone text;

alter table public.b2c_payments
  add constraint b2c_payments_customer_phone_length_check
  check (customer_phone is null or char_length(trim(customer_phone)) between 5 and 40);
