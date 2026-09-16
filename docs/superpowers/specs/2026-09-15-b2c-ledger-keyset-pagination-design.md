# B2C Ledger Period and Keyset Pagination Design

## Context

The B2C Ledger currently presents its period selector in the application title bar, outside the Ledger tab and its filters. More importantly, every Ledger request calls `getB2cDashboardSnapshot`, which fetches and decorates all B2C payments, refunds, review flags, overrides, conversions, duplicate states, contacts, and Stripe evidence before applying filters and a numeric offset in JavaScript.

The same request also rebuilds the complete Admin Work queue, and the payment-evidence endpoint loads the complete all-time snapshot to find one payment. The visible `limit` and `cursor` contract therefore does not limit database reads or application work.

This work starts from commit `2550700` on branch `remove-payment-tracker-sheet-system`. Category removal is a separate in-progress change. The existing category filter and every `category_code` path remain untouched except where unchanged values must pass through a new query interface.

## Goals

- Place the reporting-period selector inside the Ledger filter bar and render it only on the Ledger tab.
- Replace the numeric in-memory offset with stable SQL-level keyset pagination.
- Fetch and decorate only the requested Ledger page.
- Compute dashboard totals and counts with database aggregates rather than materializing all rows in JavaScript.
- Preserve every financial total, count, row value, filter result, and reportability decision.
- Keep one authoritative implementation of the B2C financial-reportability gate.
- Preserve the existing workspace endpoint and `limit`/`cursor` query contract as far as possible.
- Provide local, reproducible correctness and performance evidence on a realistically large dataset.

## Non-goals

- Removing, renaming, or restructuring the PLAYBOOK category filter or `category_code` data.
- Redesigning the Work queue or making it paginated.
- Applying any migration to the linked or remote Supabase project.
- Editing the four already-applied clean-slate migrations.
- Adding arbitrary page-number jumps. Pagination is sequential keyset navigation.

## Chosen architecture

### Database read model

Add one new forward migration after `20270101000400_cross_domain_sweep.sql`. The migration will contain only additive read-path functions and supporting indexes; it will not edit any existing migration.

The migration will define authenticated, read-only functions for:

1. Canonical B2C payment exclusion and decision reasons from effective payment facts.
2. A filtered Ledger keyset page.
3. Period-wide Ledger filter metadata and an exact count for the active filters.
4. Period financial aggregates and all-time source/review facts required by the existing dashboard snapshot.
5. A single payment's safe Stripe evidence.

The functions will enforce approved-user access internally, use a fixed `search_path`, expose no raw provider payloads, and return only fields already available through the existing approved read boundary.

The Ledger read model will normalize payments and refunds into a common set of filter and sort fields. It will retain payment/refund identity separately so the TypeScript repository can hydrate only those records and their related rows.

### Effective-date correctness

Payment period membership and Date from/to filtering use:

```sql
coalesce(b2c_payment_local_overrides.local_occurred_on, b2c_payments.occurred_on)
```

Refund membership continues to use the refund's own `occurred_at::date` because refunds have no local date override.

For index use and correctness, payment candidates will be formed as two disjoint paths:

- payments with no non-null local date override, filtered by `b2c_payments.occurred_on`;
- payments with a non-null local date override, filtered by `b2c_payment_local_overrides.local_occurred_on`.

The normalized read still carries and checks the final effective date. This includes a source payment moved into the selected period and excludes one moved out, even when its raw date says the opposite. Supporting indexes will cover local override dates and refund dates; the existing payment date index remains in use.

### Single reportability authority

PostgreSQL will become the single authoritative implementation of the B2C financial-reportability gate. A pure, stable SQL function will accept effective payment facts and return the ordered exclusion/blocking reasons and resulting reporting decision. The Ledger-page and dashboard-aggregate functions will both call this canonical function.

The prior TypeScript implementation must not remain as a second financial predicate:

- `src/server/repositories/b2c-dashboard-repository.ts` will consume the SQL-produced exclusion reasons and aggregate output instead of calling `isReportableB2cPayment` or `b2cPaymentExclusionReasons`.
- `src/lib/b2c/payment-decision.ts`, specifically the current gate call at line 121, will consume validated SQL-produced reasons instead of recalculating them from payment facts.
- `src/lib/b2c/payment-reportability.ts` may retain shared TypeScript types, but it will not retain an executable duplicate of the financial gate.
- TypeScript may translate validated reason codes into presentation text. That mapping does not decide inclusion and cannot waive or introduce a financial exclusion.

The canonical SQL decision also owns decision-only date blockers needed by the Ledger's `reportingDecision` filter, including the existing future-business-date rule. This prevents the pre-pagination SQL predicate and the returned row decision from diverging.

Existing TypeScript reportability tests will be migrated to pgTAP assertions against the canonical SQL function. TypeScript tests will cover validation of returned reason codes and deterministic presentation mapping. Before the old TypeScript implementation is removed, the large local equivalence fixture must prove byte-identical totals, exclusion reasons, and decisions between the old implementation and the new SQL authority.

This is a conscious boundary change: reportability becomes server/database-authoritative and is no longer available as a standalone synchronous TypeScript calculation. Current production callers are confined to the B2C repository/decision path, so they will all migrate in this task.

### Filters

Database filtering will preserve the current meanings of:

- source and displayed source label;
- provider/source status and displayed payment status;
- reporting decision;
- issue, including stale missing-email flag suppression when a current effective/fallback email exists;
- effective date range;
- effective category;
- foreign-currency review;
- original currency;
- absolute effective USD amount;
- customer/provider-reference search;
- date and amount sort modes.

The SQL read model will return the canonical reason codes and reporting decision alongside the independent display facts. TypeScript validates those codes and constructs the existing `B2cPaymentDecision` presentation shape without re-evaluating financial eligibility.

### Keyset cursor

The API continues accepting `cursor?: string` and `limit?: number`. A cursor becomes an opaque versioned token containing:

- selected sort mode;
- last row's nullable sort value;
- stable record kind;
- stable UUID.

Cursor decoding is validated server-side. A cursor from another sort mode or malformed token receives the existing safe validation error rather than falling back to page one.

Every ordering ends with record kind and UUID tie-breakers, so equal dates or amounts cannot duplicate or skip rows. The database requests `limit + 1` identities to determine `hasMore`; only `limit` rows are hydrated and returned.

### Summary and metadata

`getB2cDashboardSnapshot` will be split into focused reads:

- `getB2cDashboardSummary` obtains period totals/counts and source coverage without a `rows` array.
- The Ledger repository gets period filter metadata, exact filtered count, and one keyset page.
- A compatibility/all-record read remains only where the unpaginated Work queue genuinely needs it during this task.

Aggregate output must preserve current behavior that is easy to accidentally change:

- payment period uses effective payment date;
- refund period uses refund date;
- completed source USD volume uses the retained source USD amount, not a local override or FX conversion;
- reportable payment totals use the effective USD amount;
- eligible refunds require the linked payment to be reportable;
- missing data remains unavailable rather than zero;
- `reviewItems` retains its current all-time live-flag meaning;
- `hasSourceRecords` retains its current all-time source-existence meaning;
- source coverage retains its current provider activation and latest-run rules.

Filter metadata and the active filtered count will be computed entirely in PostgreSQL. The metadata function will use `count`, `count(*) filter (...)`, and `array_agg(distinct ...)` over the indexed period read model and return one compact aggregate row. No period row set will be returned to or materialized in TypeScript to build source, category, issue, or foreign-currency options. Exact arbitrary-filter counts still require PostgreSQL to scan the relevant qualifying index/table entries; the design guarantees bounded network/application work, not constant-time counts independent of data size.

### Scoped hydration

After the page identity RPC returns, the repository will issue bounded queries using only page payment/refund IDs for source rows, linked payments, flags, overrides, latest FX conversions, Finance-exception decisions, duplicate states, and contact/source-description fields. Stripe evidence remains excluded from the Viewer-safe workspace response.

The dedicated Admin evidence endpoint will use a one-payment query rather than loading the all-time dashboard snapshot.

### Work queue isolation

The workspace endpoint currently rebuilds the entire Admin Work queue for every Ledger filter and pagination request. Add an optional validated query flag that allows the client to request Work items only while the Work tab needs them. The default remains compatible with current callers, while Ledger requests explicitly opt out and continue receiving `workItems: null`.

Switching to the Work tab triggers its own load. Work-queue pagination is deliberately deferred; this task ensures it is no longer part of Ledger request cost.

## User interface

`B2cPeriodSelector` will be rendered through `B2cLedgerFilters` as the first primary control, before Search. It remains URL-backed and retains its current All time/month values. It will use the filter bar's visible-label, focus, and minimum-touch-target conventions. No category control or category state will move.

The Ledger footer will replace Load more with:

```text
Previous    Page 2 of 11    Next
```

There will be no individual clickable page numbers and no arbitrary jump. Previous and Next will be at least 44 pixels high, remain disabled at their respective boundaries, and show loading/disabled feedback during a request. The client stores page-start cursors in a history stack, resets to page one when period/filter/sort changes, and replaces rather than appends rows.

The record-count text will describe the current page range and total, for example `Showing 101–200 of 1,090 records`.

## API and type compatibility

The `/api/b2c/workspace` response keeps `rows`, `nextCursor`, `hasMore`, `totalCount`, and `filterMetadata`. It adds the minimum state needed for sequential Previous navigation if the client cannot derive it locally. The existing limit and filters remain supported.

The query contract gains only an optional Work-item inclusion flag. Existing callers that omit it preserve current behavior.

Because `src/types/database.generated.ts` is hand-maintained, new RPC signatures will be added manually. The Supabase type-generation command will never be run.

## Error handling and security

- Invalid or mismatched cursors fail safely and never silently broaden a query.
- Any failed page/metadata/aggregate query produces the existing safe repository/API error.
- Stale UI requests remain abortable and generation-guarded.
- RLS remains authoritative. Read RPCs explicitly require an approved authenticated user.
- No provider secrets, raw payloads, payment-method fields, or Admin-only evidence enter the Ledger response.
- No remote or linked Supabase command is permitted during implementation or verification.

## Correctness testing

Implementation follows red-green TDD. Tests will cover:

- the period selector exists inside the Ledger filter bar and nowhere on Work queue/Sources;
- label-only Previous/Page N of M/Next behavior, disabled boundaries, row replacement, and cursor-history reset;
- cursor validation and deterministic tie handling;
- every existing Ledger filter remains server-applied, including category unchanged;
- page hydration queries are bounded to returned IDs;
- Ledger requests do not load Work items;
- the one-payment evidence endpoint does not load the full snapshot;
- local override moves a payment from outside to inside a period;
- local override moves a payment from inside to outside a period;
- foreign-currency payment and refund conversions;
- open review flags, duplicate state, Finance exceptions, missing-email fallback, and refund eligibility;
- old and new summary/page outputs are byte-equivalent for the same query inputs;
- both `b2c-dashboard-repository.ts` and `b2c-payment-decision.ts` consume SQL-produced reasons and contain no executable copy of the reportability predicate.

A local-only dataset well above 100 rows will include payments and refunds across multiple periods, both override directions, tied dates/amounts, foreign currencies with and without FX, live flags, duplicate decisions, Finance exceptions, and multiple sources. The legacy implementation will be retained only as a test oracle until equivalence is proven, then removed from the runtime path.

## Performance verification

Record before/after timings against the same reset local database and seeded dataset for:

- initial current-month summary plus first Ledger page;
- All time first page;
- a selective search/filter request;
- next-page navigation;
- single-payment evidence lookup.

Evidence will include wall-clock repository/API timing and database `EXPLAIN (ANALYZE, BUFFERS)` output for the new candidate/page and aggregate functions. The final report will include dataset size, run count, warm-up policy, median before/after values, rows returned, and query plans demonstrating bounded page hydration.

## Migration and verification boundary

- Add one new forward migration; never modify the four existing clean-slate migrations.
- Reset and test only a local Supabase project.
- Never use `--linked` or apply schema changes to the remote project.
- Run the full pgTAP suite locally when the migration is ready.
- Run `npx tsc --noEmit`, ESLint on every changed file, and the full `npx vitest run` suite.
- Do not push or open a pull request.

## Deliberate deferrals

- The Work queue may still need an all-record decision scan while its tab is open. It is removed from Ledger request cost but not redesigned here.
- Arbitrary numbered-page jumps are omitted to preserve keyset performance and correctness. The UI exposes only Previous, Page N of M, and Next.
- Category removal remains entirely owned by `remove-b2c-category-concept` and will be merged separately.
