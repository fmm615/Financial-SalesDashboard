# Database Rules

## Database

Use Supabase PostgreSQL as the persistent database.

Application deployments must never own the only copy of financial data.

## Migrations

Every schema change must be represented by a migration committed to the repository.

Do not make undocumented production-only schema changes.

## Financial design principles

Design for:

- auditability
- source traceability
- idempotency
- duplicate prevention
- historical accuracy
- concurrency
- clear status fields
- strong foreign keys and constraints

## Source traceability

Important records should store enough information to identify their origin, such as:

- source system
- external transaction/deal ID
- provider event ID where relevant
- original currency
- exchange rate where required
- created/updated timestamps

## Financial history

Do not silently overwrite financial history when a separate correction, refund or adjustment should exist.

Refunds must be separate linked entries.

Manual corrections must record:

- who made the change
- timestamp
- before value
- after value
- reason/note where required

## Constraints

Use database constraints for rules that can be reliably enforced at the database level.

Do not depend only on frontend validation.

## Missing data

Do not store or present unknown/not-backfilled financial values as zero merely because data is absent.

## Phase 2 access and RLS

The schema has only `admin` and `viewer` roles. Every user-initiated write is Admin-only through PostgreSQL RLS; Viewers receive no write policy. All application tables have RLS enabled, anonymous access is revoked, and audit/integration logs are Admin-only reads.

## Money, dates, and types

Store money as `numeric(20,6)` and FX rates as `numeric(20,10)`. Do not use floating point. Store system timestamps as UTC `timestamptz`; store business/reporting dates separately as `date`. The database retains source currency and USD amount rather than inventing conversion or rounding values.

Foreign-currency B2C source rows keep their provider amount and have no USD amount until Finance records an append-only conversion in `b2c_payment_fx_conversions` or `b2c_refund_fx_conversions`. These tables are read-only to approved users; only authenticated Admin RPCs may insert. The RPC locks the source record, computes the USD amount from the source amount and entered rate, creates a `financial_corrections` record, and records the authenticated actor. Direct generic USD overrides for foreign source rows are rejected.

The Payment Tracker Excel-workbook system (staging, exact cross-tab duplicate grouping, lineage/canonicalization, Finance staging-row actions, and posting-into-payments) is not part of the schema — `20270101000200_b2c_foundation.sql` deliberately excludes it entirely. Historical `b2c_payments` rows with `source_system = 'finance_tracker'` remain untouched, immutable reportable ledger history. A new iOS/bank-transfer ingestion system is pending a separate design.

## B2C payment duplicate groups

`b2c_payment_duplicate_groups` and its supporting functions, originally
defined in `20270101000200_b2c_foundation.sql` and since redefined by
`20270101000500_remove_b2c_category.sql` and
`20270101000700_b2c_duplicate_window_setting.sql` (the current live
definition), are the sole authority for B2C payment content candidates: the
protected SQL constructor uses effective e-mail, verified USD amount,
business date, and an Admin-configurable window (`public.b2c_settings.
duplicate_detection_window_hours`, default 48, bounded 1-168 hours).
Application repositories must not reimplement that query or create
`possible_duplicate` flags for content matches, and must read the same
configured window rather than hardcoding their own copy of the number.

`b2c_payment_duplicate_groups` and
`b2c_payment_duplicate_group_members` retain immutable, audited group/member
history. An open group blocks reporting. An Admin-only atomic RPC resolves it
as `keep_all` (every member included) or `keep_one` (exactly one member
included); a resolved exclusion always wins over an include when reporting
eligibility is calculated. Only Admins can read membership or make decisions.
Viewer-facing reporting reads receive only safe per-payment state booleans;
Admin presentation reads may additionally retrieve the resolved group's
audited `resolution_reason` for an excluded payment without exposing other
group members.
Historical backfill is guarded:
unprovable flags remain open, while only a stale orphaned duplicate flag with
no current candidate can be dismissed by the protected Admin function.

## Retired provider product mappings

`product_mappings`, their historical mapping functions, classifications,
corrections, and review flags are retained as read-only audit history.
`20270101000200_b2c_foundation.sql` revokes
authenticated execution of the mapping functions and authenticated
`INSERT`/`UPDATE` on `product_mappings`, while preserving approved read access.

For Stripe and Tap provider payments, `category_code = 'unmapped'` remains the
stable internal duplicate-fingerprint input, not a reportability constraint.
The provider description remains source evidence and the visible product label;
it is never turned into a normalized category. The protected Finance exception
no longer requires category, but retains its Admin authorization, succeeded
status, provider-ID and no-known-duplicate confirmations, USD/date, reason,
audit, and other blocking-rule checks. Manual bank transfers and Finance
Tracker rows still require their explicit categories.
