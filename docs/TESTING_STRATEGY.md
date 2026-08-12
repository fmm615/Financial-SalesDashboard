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
- target contracts: approved financial metric codes, valid date periods, and
  quantity-unit rules
- target-management services: operational progress only for an active
  operational target, with a dated evidence note
- B2C Finance staging: approved tab scope, Excel-date/month conflicts, zero and
  invalid values, conservative duplicate candidates, recurring-payment safety,
  and Tap statement classification without a BHD-to-USD conversion

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
- target writes: Admin-only target creation, financial/operational revision,
  and operational-progress authorization
- target UI: financial actuals remain explicitly unavailable while source
  history is incomplete, and operational revisions are submitted to the server
  before the UI refreshes
- B2C Finance import/decision routes: Admin-only writes, strict pre-parsed rows,
  atomic import RPC use, and no `b2c_payments` write
- Payment Tracker upload: `.xlsx` tab/header/row-limit/formula validation,
  memory-only preview, confirmation hash matching, private Storage cleanup on
  failed finalization, and Admin-only controls with no displayed Finance total
- B2C reconciliation coverage: safe approved-viewer summary, `Not fully loaded`
  gate, source state display, and no claimed B2C Finance revenue total

Use provider sample/test payloads where possible.

HubSpot tests must also cover v3 request-signature rejection, unknown-stage rejection, non-USD FX validation, webhook-event idempotency, 48-hour reconciliation, and the rule that imported bookings never create recognised sales.

HubSpot Admin workflow tests must cover incomplete-deal correction, required correction/resolution reasons, Admin-only access, audit attribution, review-flag resolution, and the absence of HubSpot write operations.

Review Queue tests must cover Admin-only note writes, retained resolution/note
history, source-aware suggested actions, and the B2C possible-duplicate rule:
a generic resolution must not clear the flag or make the payment reportable.

### Database foundation tests

Phase 2 keeps database assertions in `supabase/tests/database_foundation.test.sql` and contract tests in `tests/database-foundation.test.ts`. After applying migrations manually to a local Supabase instance, run `npm run supabase:test` to exercise the pgTAP assertions. They cover provider-ID duplication, Stripe/B2B separation, linked partial refunds, booking versus recognised-sales separation, audit attribution, retained review history, backfill state, and RLS enablement.

Target database assertions additionally cover quantity-unit constraints,
append-only operational evidence, and atomic operational revisions that archive
the former active target before creating its replacement. The revision functions
also require an authenticated Admin.

B2C Finance database assertions cover immutable source-file hashes, allowed
Payment Tracker tabs, protected RLS tables, and the fact that raw Finance rows
remain outside `b2c_payments`. Run the pgTAP suite only after applying the
reconciliation migrations to a local Supabase database; the local Supabase CLI
is required for `npm run supabase:test`.

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
