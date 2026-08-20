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

`server/repositories/b2c-finance-ledger-repository.ts` owns the one protected
Finance-to-ledger RPC call. `lib/b2c/approved-finance-payment.ts` owns the
pure iOS/bank-transfer method, category-code, and result-shape rules. The
Admin-only posting component never builds a payment in the browser; the
database preserves the staged source-row link and the B2C dashboard reads that
link before applying the limited approved-Finance missing-e-mail rule.

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
including the source-run failures and Task 2's Finance posting-readiness rows.
Both build on the existing `b2c-dashboard-repository.ts` snapshot instead of
re-querying B2C sources, and that repository remains the compatibility facade
other consumers keep using unchanged.

`features/b2c/b2c-workspace.tsx` is the one client-rendered B2C workspace
behind `features/b2c/b2c-operations.tsx`'s thin server-data bridge: it reads
its `tab`/`queue`/`record` state from the URL, loads Work queue and Ledger
content from `/api/b2c/workspace`, and keeps the four header totals from the
server-fetched dashboard snapshot. `b2c-work-queue.tsx`, `b2c-ledger-table.tsx`,
`b2c-source-management.tsx`, and `b2c-payment-review-drawer.tsx` are its three
tabs and shared record drawer; `b2c-payment-tracker-upload.tsx`,
`b2c-tap-statement-upload.tsx`, and `b2c-stripe-charges-upload.tsx` are the
Sources tab's focused, state-machine upload controls. `/operations/b2c/reconciliation`
and `/admin/b2c-finance` are now server redirects into this one workspace so
old bookmarks keep resolving without a second live surface.

Task 7 removed the page-level UI these routes used to redirect from,
plus the two bulk-duplicate-decision API routes it made obsolete:
`features/b2c/b2c-reconciliation-page.tsx`, `b2c-finance-action-module.tsx`,
`b2c-finance-data-quality-actions.tsx`, and `b2c-finance-duplicate-actions.tsx`,
along with `api/admin/b2c/finance-actions/duplicates/bulk-canonical` and
`.../duplicates/selected`. `features/b2c/b2c-exact-duplicate-review.tsx` and
its `server/services/b2c-exact-duplicate-review.ts` read model stayed: the
shared drawer's `choose_duplicate` action still renders that component, and
`api/admin/b2c/reconciliation/exact-duplicates` (`GET`) is still the read
path it depends on to list pending groups. `api/admin/b2c/finance-actions/date-authority`
and `api/admin/b2c/finance-actions/[rowId]/correction` also stayed: they
still work and are still tested, but no live component calls either of them
now that their only callers are gone -- wiring a Finance staging-row date fix
into the drawer remains open follow-up work, not a Task 7 deletion target.

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

All database schema changes. The B2C Finance reconciliation migrations create
immutable staging/evidence tables, an atomic Finance-import function, and an
approved-user safe-summary function. The separate approved-Finance ledger
migration is the only reconciliation-related path that writes reportable B2C
payments, and only through its Admin-protected, provenance-linked transaction.

## Rule

The structure may evolve, but changes must preserve clear ownership and separation of responsibilities and must be documented here.
