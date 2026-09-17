-- ---------------------------------------------------------------------------
-- New feature: refresh already-imported Stripe payments' contact/settlement
-- evidence on demand and on a daily schedule. Discovered via a real case: a
-- customer's Stripe profile (phone, name) was set a day after her payment was
-- imported, and PLAYBOOK never noticed because nothing re-checks an
-- already-imported payment's Stripe data after the mandatory 48-hour
-- reconciliation window closes.
--
-- This never changes b2c_payments.customer_email/customer_name/customer_phone
-- (the immutable, authoritative charge-level fields) or reportability -- it
-- only re-fetches the same optional Stripe enrichment
-- (checkout/invoice/payment-method/customer-profile/settlement) already
-- collected at import time, via the exact same, already-audited code path
-- (persistCharge + persistStripeDetails).
--
-- Widens integration_sync_runs.operation_type so these refresh runs are
-- tracked distinctly from the existing 'reconciliation' (new-charge
-- discovery) and 'historical_backfill' runs, and never get picked up by
-- b2c_dashboard_summary_data's "last reconciliation"/"last backfill" source
-- coverage panel, which filters on those two exact values.
-- ---------------------------------------------------------------------------

alter table public.integration_sync_runs drop constraint integration_sync_runs_operation_type_check;
alter table public.integration_sync_runs add constraint integration_sync_runs_operation_type_check
  check (operation_type in ('reconciliation', 'historical_backfill', 'enrichment_refresh'));
