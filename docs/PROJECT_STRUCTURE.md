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
for those two providers). `supabase/migrations/20270101000200_b2c_foundation.sql`
is the B2C domain migration that creates the final schema directly and
deliberately excludes the corresponding database tables/views/functions/enums;
its header comment lists every excluded table. There is an intentional gap here: iOS
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

All database schema changes, represented as five clean, domain-scoped
migration files that create the final schema directly rather than replaying
incremental history:

- `20270101000000_foundation_and_access.sql` — extensions, shared enums,
  `profiles`/`roles`/`approved_users`/`profile_roles`.
- `20270101000100_b2b_foundation.sql` — all B2B tables/functions/RLS.
- `20270101000200_b2c_foundation.sql` — all B2C tables/functions/RLS. Its
  header comment documents that the entire Payment Tracker workbook system
  (staging, provider-evidence-CSV staging, exact cross-tab duplicate
  grouping, lineage tracking, Finance staging-row actions, and
  Finance-to-ledger posting) is deliberately excluded rather than created and
  then dropped.
- `20270101000300_finance_targets_reports.sql` — Finance/Targets/Summit/Review
  Queue/Audit Log/Reports/Integration-tracking tables.
- `20270101000400_cross_domain_sweep.sql` — audit-trigger attachment and
  baseline schema grants, applied last since it spans all four domains.

## Rule

The structure may evolve, but changes must preserve clear ownership and separation of responsibilities and must be documented here.
