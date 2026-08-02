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
