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
- B2C foreign-currency conversion: no USD amount at provider ingestion, an
  Admin-only append-only Finance conversion with source/rate/effective-date/
  reason, server-calculated USD amount, generic foreign-currency USD override
  rejection, and converted-refund total not exceeding the converted payment
- Stripe API enrichment: GET-only client requests, strict provider-object
  validation, fixed transaction-contact precedence, mutable fallback isolation,
  one Charge/one payment idempotency, partial lookup retention, settlement
  evidence separation, read-only selected dashboard evidence, and labelled
  dashboard contacts that do not change reportability or financial totals

Use provider sample/test payloads where possible.

HubSpot tests must also cover v3 request-signature rejection, unknown-stage rejection, non-USD FX validation, webhook-event idempotency, 48-hour reconciliation, and the rule that imported bookings never create recognised sales.

HubSpot Admin workflow tests must cover incomplete-deal correction, required correction/resolution reasons, Admin-only access, audit attribution, review-flag resolution, and the absence of HubSpot write operations.

Review Queue tests must cover Admin-only note writes, retained resolution/note
history, source-aware suggested actions, and the B2C possible-duplicate rule:
a generic resolution must not clear the flag or make the payment reportable.

### Database foundation tests

Phase 2 keeps database assertions in `supabase/tests/database_foundation.test.sql` and contract tests in `tests/database-foundation.test.ts`. After applying migrations manually to a local Supabase instance, run `npm run supabase:test` to exercise the pgTAP assertions. They cover provider-ID duplication, Stripe/B2B separation, linked partial refunds, booking versus recognised-sales separation, audit attribution, retained review history, backfill state, and RLS enablement.

pgTAP is the only layer that verifies a formula duplicated across the
TypeScript/SQL boundary. It requires Docker running plus `npm run
supabase:start`; `npm run supabase:reset` applies every migration and `npm
run supabase:test` runs the assertions. Run it before trusting any change to
B2C Finance identity, lineage, posting, or duplicate logic -- the Vitest suite
compares TypeScript to TypeScript only and cannot see a cross-language
divergence.

Target database assertions additionally cover quantity-unit constraints,
append-only operational evidence, and atomic operational revisions that archive
the former active target before creating its replacement. The revision functions
also require an authenticated Admin.

The Payment Tracker Excel-workbook system (staging, exact cross-tab duplicate
grouping, lineage/canonicalization, Finance staging-row actions, posting into
payments, and Stripe/Tap-vs-sheet provider-evidence reconciliation) has been
removed entirely -- see `20260901100000_remove_payment_tracker_sheet_system.sql`.
The pgTAP assertions and Vitest suites that only covered that removed system
were deleted alongside it. A new iOS/bank-transfer ingestion system is pending
a separate design, and its own test coverage will be added with it.

Manual bank-transfer entry (`tests/b2c-manual-bank-transfer.test.ts`,
`tests/b2c-manual-bank-transfer-api.test.ts`,
`tests/b2c-manual-bank-transfer-ui.test.tsx`) is covered at every layer: the
prepared-input and hash helpers, the repository's read-only duplicate
assessment against exact bank reference and the standard 48-hour content
check, the route boundary's Admin-only access and stale-hash rejection, and
the Step-1/Step-2 UI state machine including the blocked-from-totals
possible-duplicate warning. pgTAP assertions in `database_foundation.test.sql`
additionally cover the protected `record_b2c_manual_bank_transfer` RPC
directly: a clean transfer creates exactly one payment, a reused bank
reference is rejected outright, a possible content match is retained with one
blocking review flag, a stale reviewed-input hash writes nothing, actor/reason
attribution is recorded, and a Viewer is denied at the database layer.

### End-to-end tests

Cover critical workflows such as:

- approved user login
- B2C transaction appearing correctly
- manual bank-transfer entry
- record correction with audit history
- review queue resolution
- report generation/download

No Playwright spec exists yet in this repository (no `@playwright/test`
dependency, no `playwright.config.ts`, no seeded test Supabase project or
Google-OAuth `storageState` fixtures); `tests/e2e/**` remains excluded from
`npm run typecheck`, `npm run lint`, and `npx vitest run` until one is added.
The previous spec was written against the since-removed Payment Tracker
workflow and was deleted with it; a new acceptance spec should be written
once the replacement iOS/bank-transfer ingestion system exists.

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
