# Testing Strategy

Financial correctness must be testable.

## Required test categories

### Unit tests

Test:

- financial calculations
- duplicate detection
- refund behavior
- classification rules
- currency/conversion logic where implemented
- status transitions
- draft-report content must remain explicitly non-financial until Finance approves provider totals
- generated draft PDFs and CSVs must carry the same draft/coverage status
- disabled report delivery must return a safe disabled result and must not contact an email provider

### Integration tests

Test:

- Stripe webhook processing
- Tap webhook processing
- HubSpot sync/webhook mapping
- database writes
- authorization boundaries
- report data preparation
- report job failure, stale-job recovery, retry, private archive, and download authorization
- draft job generation/readiness boundaries and the rule that no delivery attempt is recorded while email is disabled
- live Review Queue loading, empty, error, filter, detail-history, and
  Viewer/Admin note presentation states
- the rule that a queue note refreshes retained history only after a successful
  server response and that no browser-only action changes a flag status

Use provider sample/test payloads where possible.

HubSpot tests must also cover v3 request-signature rejection, unknown-stage rejection, non-USD FX validation, webhook-event idempotency, 48-hour reconciliation, and the rule that imported bookings never create recognised sales.

HubSpot Admin workflow tests must cover incomplete-deal correction, required correction/resolution reasons, Admin-only access, audit attribution, review-flag resolution, and the absence of HubSpot write operations.

Review Queue tests must cover Admin-only note writes, retained resolution/note
history, source-aware suggested actions, and the B2C possible-duplicate rule:
a generic resolution must not clear the flag or make the payment reportable.

### Database foundation tests

Phase 2 keeps database assertions in `supabase/tests/database_foundation.test.sql` and contract tests in `tests/database-foundation.test.ts`. After applying migrations manually to a local Supabase instance, run `npm run supabase:test` to exercise the pgTAP assertions. They cover provider-ID duplication, Stripe/B2B separation, linked partial refunds, booking versus recognised-sales separation, audit attribution, retained review history, backfill state, and RLS enablement.

### End-to-end tests

Cover critical workflows such as:

- approved user login
- B2C transaction appearing correctly
- manual bank-transfer entry
- record correction with audit history
- review queue resolution
- report generation/download

## Regression tests

When fixing a critical financial bug, add a test that would have caught that bug whenever practical.

## Known-value validation

Critical financial totals must be tested using small datasets with manually known expected results.

Examples:

- sale + full refund = net zero
- sale + partial refund = original minus refund
- duplicate event does not increase totals
- booking is not added to recognised revenue
- missing period is not represented as zero

## Completion rule

A feature is not complete until its relevant tests pass.
