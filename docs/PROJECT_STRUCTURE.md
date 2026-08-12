# Project Structure

The old implementation is isolated from the clean rebuild.

Suggested structure:

```text
/
├── AGENTS.md
├── README.md
├── old-project/              # read-only reference
├── docs/
├── supabase/
│   └── migrations/
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   └── api/
│   ├── components/
│   ├── mocks/                # typed, UI-phase mock datasets only
│   ├── features/
│   │   ├── b2c/
│   │   ├── b2b/
│   │   ├── finance/
│   │   ├── targets/
│   │   ├── reports/
│   │   ├── admin/
│   │   ├── review-queue/
│   │   └── summit/
│   ├── lib/
│   │   ├── auth/
│   │   ├── motion.ts         # reusable UI motion variants
│   │   ├── supabase/
│   │   ├── validation/
│   │   └── integrations/
│   ├── server/
│   │   ├── services/
│   │   ├── repositories/
│   │   └── jobs/
│   └── types/
└── tests/
```

## Folder rules

### `old-project/`

Read-only reference. Never used as the new application runtime.

### `features/`

Business-domain UI and feature-specific logic.

### `mocks/`

Phase 1 data fixtures are isolated by business area. UI pages compose these typed fixtures and must not hardcode representative financial values inline. Replace fixtures with application/data access layers in a later approved phase without changing presentational components.

### `components/`

Reusable accessible presentation components: application shell, state views, tables, charts, form fields, and detail/history primitives. They contain no provider logic or financial calculations.

### `server/services/`

Business/application operations. Keep API routes thin.

### `server/repositories/`

Database access patterns where a repository abstraction is useful.

The target-management repository and services own operational progress reads
and writes. Target-definition revisions remain database RPCs so archiving the
old version and creating the successor are one atomic, audited operation.

The B2C Finance reconciliation repository owns only request-scoped staged
imports, audited decisions, and the safe coverage summary. Pure Finance row,
duplicate-candidate, and Tap-statement classification rules live in
`server/services/b2c-finance-reconciliation.ts`; strict source contracts live
in `lib/validation/b2c-finance-import-contracts.ts`. The Operations page uses
only the safe summary API, not raw Supabase rows.

Exact Finance duplicate grouping uses its own repository, review model, and
Admin-only routes/component. Direct Finance contact fields never leave that
Admin boundary; Viewers retain the existing coverage-only view.

The Payment Tracker workbook parser and upload orchestration are also isolated
in `server/services/`: they validate source bytes, create a safe preview, and
stage an explicitly confirmed original file through private Storage and the
existing Finance-import repository. Multipart routes remain thin Admin-only
boundaries; the UI never parses workbook bytes or receives raw Finance rows.

Tap-statement and Stripe-Charges CSV parsing live in focused provider-evidence
services. Their upload services re-parse and hash the selected file, then call
their own protected finalizers. Stripe evidence keeps only typed Admin review
contacts and a minimized payload; sensitive export fields remain in private
Storage rather than spreading through application models.

Stripe API enrichment normalization lives in
`lib/integrations/stripe/enrichment.ts`. The GET-only client retrieves referenced
Stripe objects, `server/services/sync-stripe.ts` coordinates optional reads, and
the provider repository persists only typed one-to-one details. The general B2C
dashboard consumes a protected contact-fallback function; Admin-only settlement
evidence does not cross into its financial snapshot.

### `lib/supabase/` and `lib/validation/`

Request-scoped and trusted-server Supabase client factories live in `lib/supabase/`. Zod write contracts live in `lib/validation/`. Raw generated database rows belong in `types/database.generated.ts`; UI components must consume feature/domain types instead.

### `middleware.ts` and `app/auth/`

`middleware.ts` is the server-side session, allowlist, and route-authorization gate. `app/auth/callback/route.ts` exchanges the Google OAuth code for a Supabase cookie session. Neither contains OAuth client secrets.

### `lib/integrations/`

Provider-specific code and normalization.

### `supabase/migrations/`

All database schema changes. The B2C Finance reconciliation migrations create
immutable staging/evidence tables, an atomic Finance-import function, and an
approved-user safe-summary function. They do not write to reportable B2C tables.

## Rule

The structure may evolve, but changes must preserve clear ownership and separation of responsibilities and must be documented here.
