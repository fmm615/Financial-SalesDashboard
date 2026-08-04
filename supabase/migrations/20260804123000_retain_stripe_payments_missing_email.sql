-- Provider source records with no direct email must remain visible for Admin
-- review. They stay excluded from financial totals until corrected locally.
alter table public.b2c_payments
  alter column customer_email drop not null;
