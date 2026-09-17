-- ---------------------------------------------------------------------------
-- One-time data correction: recompute every succeeded B2C payment's stored
-- duplicate_fingerprint using the current (no-category, post-
-- 20270101000500_remove_b2c_category.sql) algorithm.
--
-- Why this exists: duplicate_fingerprint is derived once at ingestion time
-- and never automatically refreshed. Production's ~1090 payments were
-- imported (imported_at clustered in a single ~72-minute window on
-- 2026-09-15) before this column's formula stopped including category, so
-- every stored value is stale relative to the current computation -- spot-
-- checked directly against the live public.get_effective_b2c_duplicate_facts
-- for a sample of 10 payments before writing this migration: 0 of 10 stored
-- values matched a fresh recomputation.
--
-- Whether this matters depends on which caller reads the column:
--   - public.open_b2c_payment_duplicate_group (the Ledger's own duplicate
--     flagging, 20270101000700_b2c_duplicate_window_setting.sql) never reads
--     the stored column at all -- it recomputes get_effective_b2c_duplicate_
--     facts fresh for every candidate on both sides of the comparison, so it
--     was never affected by this staleness.
--   - SupabaseB2cPaymentsRepository.assessManualBankTransferDuplicates
--     (src/server/repositories/b2c-payments-repository.ts) computes a FRESH
--     fingerprint for the new transfer under the current algorithm, then
--     looks up existing payments by exact equality against the STORED
--     column. A stale stored value means a real duplicate would silently go
--     undetected. No manual bank transfer has ever been recorded in
--     production, so this has not yet caused an incident -- but it would on
--     the first one that happens to duplicate an existing Stripe/Tap
--     payment.
--
-- Why an in-place update rather than the wipe-and-reimport this project's
-- own runbook (docs/superpowers/plans/2026-09-15-b2c-category-removal-
-- remote-rollout.md) originally called for: that plan predates this
-- migration and reasoned that reproducing the exact ingestion inputs to
-- backfill in place would be fragile. get_effective_b2c_duplicate_facts
-- removes that fragility -- it is the same live function the ledger's own
-- duplicate detection already trusts, and it derives the fingerprint from
-- each payment's current effective values (respecting any local override),
-- not from re-fetched provider data. Recomputing through it is exactly as
-- authoritative as the value the app already relies on elsewhere.
--
-- Side effects, checked before writing this migration:
--   - Only duplicate_fingerprint changes, so
--     open_b2c_payment_duplicate_group_after_payment_write (scoped to
--     payment_status/customer_email/amount_usd/occurred_at/occurred_on) does
--     NOT fire -- no new duplicate groups or review flags are created by
--     this migration itself.
--   - audit_b2c_payments (write_audit_event) does fire per changed row --
--     intentional: it is correct for the audit trail to show these values
--     were corrected and when.
--   - get_effective_b2c_duplicate_facts requires payment_status = 'succeeded'
--     and a non-null effective email/amount/date, so a payment missing any
--     of those (or not succeeded) has no matching row from the function and
--     is left untouched -- correct, since the manual-transfer duplicate
--     check itself only ever compares against succeeded payments.
--   - `is distinct from` makes this safe to run more than once: a payment
--     already holding the correct value is not rewritten, so re-running
--     touches zero rows.
-- ---------------------------------------------------------------------------

-- A plain `from public.get_effective_b2c_duplicate_facts(p.id) f` does not
-- work here: UPDATE ... FROM cannot correlate a FROM-clause function call
-- back to the target row without an explicit LATERAL join (42P10 "invalid
-- reference to FROM-clause entry for table p", confirmed by actually running
-- this against a local reset before writing it this way). The subquery below
-- does that lateral correlation on independent, already-existing rows (the
-- same cross-join-lateral shape open_b2c_payment_duplicate_group already
-- uses), then the outer UPDATE just joins its result back to the target by id.
update public.b2c_payments p
set duplicate_fingerprint = f.fingerprint
from (
  select b.id, d.fingerprint
  from public.b2c_payments b
  cross join lateral public.get_effective_b2c_duplicate_facts(b.id) d
) f
where f.id = p.id
  and p.duplicate_fingerprint is distinct from f.fingerprint;
