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

The entire Payment Tracker Excel-workbook system has been removed: the
workbook parser/upload orchestration, the Finance staging/reconciliation
repository and services, exact cross-tab duplicate grouping, lineage
tracking/canonicalization, Finance staging-row corrections/date-authority
actions, and the Finance-to-ledger posting repository/RPC. Tap-statement and
Stripe-Charges CSV upload/evidence-staging services were removed earlier for
the same reason (Stripe's and Tap's own APIs are now the sole source of truth
for those two providers). `supabase/migrations/20260901100000_remove_payment_tracker_sheet_system.sql`
drops the corresponding database tables/views/functions/enums; no earlier
migration file was edited or deleted. There is an intentional gap here: iOS
and bank-transfer ingestion has no automated intake path until a new one is
designed and built. Historical `b2c_payments` rows with
`source_system = 'finance_tracker'` are untouched and remain reportable ledger
history.

Stripe API enrichment normalization lives in
`lib/integrations/stripe/enrichment.ts`. The GET-only client retrieves referenced
Stripe objects, `server/services/sync-stripe.ts` coordinates optional reads, and
the provider repository persists only typed one-to-one details. The general B2C
dashboard consumes protected, read-only functions for contact fallbacks and a
small selected Stripe-evidence set. Those values are traceability context only:
they do not enter the financial snapshot or totals, and raw provider/payment
data remains outside the general dashboard boundary.

`lib/b2c/payment-decision.ts` owns the one pure mapping from the approved
financial gate to the richer `B2cPaymentDecision`/`B2cBlockingReason` model;
`server/services/b2c-work-items.ts` owns the pure, internally detailed
`B2cWorkItem` prioritization built on top of it. `server/repositories/
b2c-ledger-repository.ts` owns the paged, filtered, decorated ledger read, and
`server/repositories/b2c-workspace-repository.ts` owns Work-queue aggregation,
including the source-run failures. Both build on the existing
`b2c-dashboard-repository.ts` snapshot instead of re-querying B2C sources, and
that repository remains the compatibility facade other consumers keep using
unchanged.

`features/b2c/b2c-workspace.tsx` is the one client-rendered B2C workspace
behind `features/b2c/b2c-operations.tsx`'s thin server-data bridge: it reads
its `tab`/`queue`/`record` state from the URL, loads Work queue and Ledger
content from `/api/b2c/workspace`, and keeps the four header totals from the
server-fetched dashboard snapshot. `b2c-work-queue.tsx`, `b2c-ledger-table.tsx`,
`b2c-source-management.tsx`, and `b2c-payment-review-drawer.tsx` are its three
tabs and shared record drawer; `b2c-source-management.tsx` now owns only
Stripe/Tap sync-and-backfill controls and the Manual Bank Transfer entry
form -- the Payment Tracker workbook upload, Tap statement upload, and Stripe
Charges upload controls that used to live there have been removed along with
their underlying services.

`tests/e2e/b2c-workspace-flow.spec.ts` is a Playwright acceptance spec for
this workspace, written against the shipped selectors/routes but not yet
runnable: Playwright is not installed in this repository. `tests/e2e/**` is
excluded from `tsconfig.json`, `eslint.config.mjs`, and `vitest.config.ts`
until a follow-up task adds the dependency and its own config.

### `lib/supabase/` and `lib/validation/`

Request-scoped and trusted-server Supabase client factories live in `lib/supabase/`. Zod write contracts live in `lib/validation/`. Raw generated database rows belong in `types/database.generated.ts`; UI components must consume feature/domain types instead.

### `middleware.ts` and `app/auth/`

`middleware.ts` is the server-side session, allowlist, and route-authorization gate. `app/auth/callback/route.ts` exchanges the Google OAuth code for a Supabase cookie session. Neither contains OAuth client secrets.

### `lib/integrations/`

Provider-specific code and normalization.

### `supabase/migrations/`

All database schema changes, additive-only: an existing migration file is
never edited or deleted, even when a later migration removes what it created.
`20260901100000_remove_payment_tracker_sheet_system.sql` is the single
migration that drops the entire Payment Tracker workbook system (staging,
provider-evidence-CSV staging, exact cross-tab duplicate grouping, lineage
tracking, Finance staging-row actions, and Finance-to-ledger posting) plus the
one Payment-Tracker-specific check inside `record_b2c_manual_bank_transfer`;
every table/function/enum it drops was created across many earlier migration
files (`20260812090000` through `20260820113000`) that remain in the repository
unedited as history.

## Rule

The structure may evolve, but changes must preserve clear ownership and separation of responsibilities and must be documented here.
