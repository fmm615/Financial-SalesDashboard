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
