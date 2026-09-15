# B2C Ledger Keyset Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move period selection into the Ledger filter bar and replace full-history B2C reads with financially equivalent SQL aggregates and stable keyset pages.

**Architecture:** PostgreSQL owns one canonical payment-decision predicate and exposes secure aggregate, metadata, keyset-identity, and one-payment-evidence RPCs. TypeScript validates SQL reason codes, hydrates only returned page IDs, and keeps the workspace contract while the client uses cursor history for label-only Previous/Next navigation.

**Tech Stack:** Next.js 15, React 19, TypeScript 5.7, Supabase/PostgreSQL, Zod, Vitest/Testing Library, pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-15-b2c-ledger-keyset-pagination-design.md`

## Global Constraints

- Base is `remove-payment-tracker-sheet-system` commit `2550700`; branch is `b2c-ledger-keyset-pagination`.
- Preserve the category dropdown and every `category_code` path unchanged.
- Add only `supabase/migrations/20270101000500_b2c_ledger_keyset_reads.sql`; edit no existing migration.
- Never run `--linked`, access remote Supabase, or run Supabase type generation. All database work is local.
- Financial totals, counts, reasons, decisions, filters, and row values remain byte-identical.
- Payment date is `coalesce(override.local_occurred_on, payment.occurred_on)`; refund date is `occurred_at::date`.
- PostgreSQL is the only production reportability/decision implementation; TypeScript validates and presents SQL results.
- Pagination is label-only `Previous`, `Page N of M`, `Next`, with no page-number buttons or jumps.
- Keep the Work queue unpaginated but never load it for Ledger requests.
- Every RPC checks approved access, fixes `search_path`, and returns no secret/raw provider payload.

---

## File Responsibilities

- New migration: indexes plus canonical decision, page, metadata, summary, and evidence RPCs.
- `payment-reportability.ts`: reason schemas/types only; `payment-decision.ts`: SQL-result presentation only.
- Dashboard repository: summary mapping and bounded page hydration; Ledger repository: cursor/RPC orchestration.
- Workspace route/UI: tab-scoped work loading and cursor-history navigation.
- Local pgTAP/Vitest fixture and performance runner: correctness and measured evidence.

### Task 1: Freeze the Baseline and Legacy Oracle

**Files:**
- Create: `tests/fixtures/b2c-ledger-equivalence.ts`
- Create: `scripts/b2c-ledger-performance.mjs`
- Modify: `tests/b2c-ledger-repository.test.ts`

**Interfaces:**
- Consumes: legacy `pageB2cLedgerRows` and `getB2cDashboardSnapshot`.
- Produces: `buildB2cLedgerEquivalenceFixture(count): B2cLedgerEquivalenceFixture`; runner modes `legacy|keyset|equivalence`.

- [ ] **Step 1: Record baseline counts**

```bash
npx vitest run --reporter=json --outputFile=/private/tmp/b2c-ledger-baseline-vitest.json
node -e 'const r=require("/private/tmp/b2c-ledger-baseline-vitest.json"); console.log({files:r.numTotalTestSuites,tests:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests})'
```

- [ ] **Step 2: Write the failing fixture contract**

```ts
const fixture = buildB2cLedgerEquivalenceFixture(1_250);
expect(fixture.payments).toHaveLength(1_250);
expect(fixture.namedCases).toMatchObject({
  movedIn: expect.any(String), movedOut: expect.any(String),
  foreignConverted: expect.any(String), foreignMissingFx: expect.any(String),
  openFlag: expect.any(String), duplicateExcluded: expect.any(String),
  financeException: expect.any(String),
});
```

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/b2c-ledger-repository.test.ts`

Expected: missing fixture helper.

- [ ] **Step 4: Implement deterministic local fixture and legacy timer**

Use fixed UUIDs and arithmetic dates across 18 months, over 100 refunds, tied sorts, both override directions, FX with/without conversion, flags, duplicates, and exceptions. The runner must only reset/seed local Supabase, warm once, execute five timed requests, and emit dataset size, durations, median, rows, and count.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/b2c-ledger-repository.test.ts
git add tests/fixtures/b2c-ledger-equivalence.ts tests/b2c-ledger-repository.test.ts scripts/b2c-ledger-performance.mjs
git commit -m "test: add B2C ledger equivalence fixture"
```

### Task 2: Add Canonical SQL Decisions and Read RPCs

**Files:**
- Create: `supabase/migrations/20270101000500_b2c_ledger_keyset_reads.sql`
- Create: `supabase/tests/b2c_ledger_keyset.test.sql`
- Modify: `supabase/tests/database_foundation.test.sql`
- Modify: `src/types/database.generated.ts`

**Interfaces:**
- Produces `b2c_payment_decision_reasons(...) returns jsonb` with ordered exclusion/blocking reasons plus decision/status facts.
- Produces `get_b2c_ledger_page(...) returns table(record_type, record_id, sort_date, sort_amount_usd, decision)`, at most `limit + 1`.
- Produces `get_b2c_ledger_metadata(...) returns jsonb`, `get_b2c_dashboard_summary(...) returns jsonb`, and Admin-only `get_b2c_payment_evidence(uuid) returns jsonb`.

- [ ] **Step 1: Write failing decision pgTAP**

Assert exact ordered outputs for status, FX/amount, email, duplicates, follow-up, Finance exceptions/provenance, and future dates:

```sql
select is(
  public.b2c_payment_decision_reasons('succeeded', null, 'USD', 100, false, false, false, false, false, 'stripe', date '2026-08-20', date '2026-08-20')->>'reporting_decision',
  'blocked', 'missing email remains blocked without an audited exception'
);
```

- [ ] **Step 2: Write failing date/filter/keyset/aggregate/security pgTAP**

Raw July overridden into August must be included; raw August overridden into July excluded. Tied rows across consecutive pages must have no repetition/omission. Exercise every filter including unchanged `category_code`. Metadata is one sorted aggregate row; summary preserves source/effective USD, eligible refunds, all-time review/source semantics. Anonymous/unapproved users are rejected; Viewer evidence is rejected.

- [ ] **Step 3: Run RED locally**

```bash
npx supabase db reset --local
npx supabase test db --local supabase/tests/b2c_ledger_keyset.test.sql
```

- [ ] **Step 4: Implement the one forward migration**

Add partial indexes for non-null override dates and refund dates. Use disjoint raw-date/override-date candidates, separate refunds, the canonical reason function for filtering and output, nullable-safe `(sort_value, record_type, id)` seek predicates, approved-user guards, fixed `search_path`, and least-privilege grants. Metadata uses `count`, `count(*) filter`, and `array_agg(distinct ...)` and returns no row collection.

- [ ] **Step 5: Hand-add exact RPC Args/Returns to database types**

Do not invoke a generator.

- [ ] **Step 6: Run GREEN and commit**

```bash
npx supabase db reset --local
npx supabase test db --local supabase/tests/b2c_ledger_keyset.test.sql
npm run supabase:test
git add supabase/migrations/20270101000500_b2c_ledger_keyset_reads.sql supabase/tests/b2c_ledger_keyset.test.sql supabase/tests/database_foundation.test.sql src/types/database.generated.ts
git commit -m "feat: add B2C ledger keyset read model"
```

### Task 3: Consume SQL Decisions in Both Named TypeScript Paths

**Files:**
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `src/lib/b2c/payment-decision.ts`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `tests/b2c-payment-reportability.test.ts`
- Modify: `tests/b2c-payment-decision.test.ts`

**Interfaces:**
- Produces `parseB2cSqlPaymentDecision(unknown): B2cSqlPaymentDecision` and `presentB2cPaymentDecision(input): B2cPaymentDecision`.
- Removes executable `isReportableB2cPayment`, `b2cPaymentExclusionReasons`, and the current line-121 gate.
- Dashboard totals and rows consume SQL output; neither named file recalculates eligibility.

- [ ] **Step 1: Write failing validation/presentation tests**

Cover every accepted code, stable ordering, unknown rejection, inconsistent `reportable`+reasons rejection, and exact explanations:

```ts
expect(() => parseB2cSqlPaymentDecision({
  reporting_decision: "blocked", blocking_reasons: ["invented_reason"],
})).toThrow(/invalid B2C decision/i);
```

- [ ] **Step 2: Add behavioral SQL-authority assertions**

```ts
const sqlSaysBlocked = sqlDecision({
  reporting_decision: "blocked",
  blocking_reasons: ["possible_duplicate"],
});
expect(presentB2cPaymentDecision({
  sqlDecision: sqlSaysBlocked,
  sourceSystem: "stripe",
  paymentStatus: "succeeded",
})).toMatchObject({
  reportingDecision: "blocked",
  blockingReasons: ["possible_duplicate"],
});
```

For the dashboard repository, return SQL aggregate/reason output that deliberately disagrees with otherwise clean source facts and assert the dashboard follows the SQL count/decision. These tests catch either named consumer reintroducing a TypeScript financial calculation. Source-symbol searches remain a final audit command, not a unit test.

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/b2c-payment-reportability.test.ts tests/b2c-payment-decision.test.ts`

- [ ] **Step 4: Implement schema validation and presentation only**

Zod validates all SQL codes and consistency. Presentation maps codes to labels/text but may not inspect amount, email, date, flags, exceptions, or duplicates to decide inclusion. Migrate both the dashboard calls and former `payment-decision.ts:121` call.

- [ ] **Step 5: Run GREEN, prove no callers, commit**

```bash
npx vitest run tests/b2c-payment-reportability.test.ts tests/b2c-payment-decision.test.ts
rg -n 'isReportableB2cPayment|b2cPaymentExclusionReasons|isImplausibleFutureBusinessDate' src/lib/b2c/payment-decision.ts src/server/repositories/b2c-dashboard-repository.ts
git add src/lib/b2c/payment-reportability.ts src/lib/b2c/payment-decision.ts src/server/repositories/b2c-dashboard-repository.ts tests/b2c-payment-reportability.test.ts tests/b2c-payment-decision.test.ts
git commit -m "refactor: consume SQL B2C payment decisions"
```

Expected: tests pass and `rg` has no matches in either owner-named file.

### Task 4: Split Aggregate Summary from Bounded Hydration

**Files:**
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/server/repositories/b2c-workspace-repository.ts`
- Modify: `src/app/operations/b2c/page.tsx`
- Create: `tests/b2c-dashboard-summary.test.ts`

**Interfaces:**
- Produces `getB2cDashboardSummary(client, today, period): Promise<B2cDashboardSnapshotWithoutRows>`.
- Produces `hydrateB2cLedgerRows(client, identities): Promise<B2cLedgerRow[]>`, with every related read constrained to IDs.
- Retains full snapshot only for the explicitly unpaginated Work queue.

- [ ] **Step 1: Write failing mapping/bounded-query tests**

Assert summary calls only `get_b2c_dashboard_summary`; hydration uses `.in("id", paymentIds)`, `.in("payment_id", paymentIds)`, and `.in("id", refundIds)` for all dependent tables, never unconstrained reads, and sends SQL decisions into the presenter.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/b2c-dashboard-summary.test.ts`

- [ ] **Step 3: Implement summary/hydration**

Preserve currency formatting/null semantics. Make the operations page call summary and attach `rows: []`; isolate legacy all-record work behind the Work path.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run tests/b2c-dashboard-summary.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-tap-ledger-source-fields.test.ts tests/b2c-work-items.test.ts
git add src/server/repositories/b2c-dashboard-repository.ts src/server/repositories/b2c-workspace-repository.ts src/app/operations/b2c/page.tsx tests/b2c-dashboard-summary.test.ts
git commit -m "refactor: split B2C summary from row hydration"
```

### Task 5: Keyset Repository, Work Isolation, and Evidence

**Files:**
- Modify: `src/server/repositories/b2c-ledger-repository.ts`
- Modify: `src/lib/validation/b2c-workspace-contracts.ts`
- Modify: `src/app/api/b2c/workspace/route.ts`
- Modify: `src/app/api/admin/b2c/payments/[paymentId]/evidence/route.ts`
- Modify: `tests/b2c-ledger-repository.test.ts`, `tests/b2c-workspace-api.test.ts`
- Create: `tests/b2c-payment-evidence-api.test.ts`

**Interfaces:**
- Cursor: base64url JSON `{version:1, sort, value:string|null, recordType:"Payment"|"Refund", id}`.
- `includeWorkItems=false` skips overview; omission is compatible; `true` loads it only for Admin.
- Evidence calls only `get_b2c_payment_evidence({p_payment_id})`.

- [ ] **Step 1: Write failing repository/API tests**

Cover cursor round-trip/malformed/version/sort mismatch, ties, `limit + 1`, metadata, bounded hydration, and no snapshot. Cover Admin opt-out, Work opt-in, Viewer denial, evidence ID scope/404/safe errors.

- [ ] **Step 2: Change validation without category edits**

Cursor becomes `z.string().trim().min(1).max(1000)`; add `includeWorkItems: z.enum(["true","false"]).transform(v => v === "true").optional()`.

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/b2c-ledger-repository.test.ts tests/b2c-workspace-api.test.ts tests/b2c-payment-evidence-api.test.ts`

- [ ] **Step 4: Implement bounded repository/routes**

Decode before RPC; request `limit + 1`; hydrate `limit`; make next cursor from the last returned identity; run page/metadata concurrently. Strip `includeWorkItems` before `page`. Evidence performs one Admin RPC and never imports full snapshot.

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run tests/b2c-ledger-repository.test.ts tests/b2c-workspace-api.test.ts tests/b2c-payment-evidence-api.test.ts
git add src/server/repositories/b2c-ledger-repository.ts src/lib/validation/b2c-workspace-contracts.ts src/app/api/b2c/workspace/route.ts src/app/api/admin/b2c/payments/[paymentId]/evidence/route.ts tests/b2c-ledger-repository.test.ts tests/b2c-workspace-api.test.ts tests/b2c-payment-evidence-api.test.ts
git commit -m "perf: bound B2C ledger workspace reads"
```

### Task 6: Filter-Bar Period and Label-Only Pagination

**Files:**
- Modify: `src/features/b2c/b2c-ledger-filters.tsx`
- Modify: `src/features/b2c/b2c-workspace.tsx`
- Modify: `tests/b2c-workspace-ui.test.tsx`

**Interfaces:**
- `B2cLedgerFilters` gains `periodMonth` and renders `B2cPeriodSelector` first.
- Client stores page number/page-start cursor history and replaces rows.
- Ledger sends `includeWorkItems=false`; Work sends `true`.

- [ ] **Step 1: Write failing placement/navigation tests**

Period is within Ledger filters before Search, absent from Work/Sources, and absent from AppShell controls. Category remains in More filters. Stub three pages and assert Previous disabled / Page 1 of 3 / Next, row replacement, correct Previous cursor, reset on filter/period change, and no numeric page buttons.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/b2c-workspace-ui.test.tsx`

- [ ] **Step 3: Implement UI**

Remove AppShell controls; render period first. Replace append/load-more state with replacement/history. Use `Math.max(1, Math.ceil(totalCount / limit))`, range labels, `min-h-11`, and loading/disabled states. Do not move or alter category JSX/state/query wiring.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run tests/b2c-workspace-ui.test.tsx tests/b2c-ui-ownership.test.tsx
git add src/features/b2c/b2c-ledger-filters.tsx src/features/b2c/b2c-workspace.tsx tests/b2c-workspace-ui.test.tsx
git commit -m "feat: unify B2C ledger filters and pagination"
```

### Task 7: Equivalence, Performance, and Full Verification

**Files:**
- Modify: `scripts/b2c-ledger-performance.mjs`
- Create: `docs/performance/2026-09-15-b2c-ledger-keyset-results.md`

**Interfaces:** Consumes both paths; produces measured evidence only.

- [ ] **Step 1: Run byte-equivalence**

Run: `node scripts/b2c-ledger-performance.mjs --mode=equivalence --runs=5`

Expected: zero differences for totals, counts, metadata, ordered IDs, row fields, reasons, and decisions across period/filter/sort/page and override cases.

- [ ] **Step 2: Measure and EXPLAIN**

```bash
node scripts/b2c-ledger-performance.mjs --mode=legacy --runs=5
node scripts/b2c-ledger-performance.mjs --mode=keyset --runs=5
```

Warm once; measure current month, All time, selective filter, next page, and evidence against identical local data. Capture `EXPLAIN (ANALYZE, BUFFERS)` for page candidates and aggregates.

- [ ] **Step 3: Record exact dataset, commands, medians, speedups, rows hydrated, and plan/buffer lines**

Do not describe estimates as measured results.

- [ ] **Step 4: Verify scope and single authority**

```bash
git diff 2550700 --name-only -- supabase/migrations
rg -n 'isReportableB2cPayment|b2cPaymentExclusionReasons' src/server/repositories/b2c-dashboard-repository.ts src/lib/b2c/payment-decision.ts
git diff 2550700 -- src/features/b2c/b2c-ledger-filters.tsx src/features/b2c/b2c-workspace.tsx | rg 'category|category_code'
```

Expected: one new migration, no financial predicate calls in either named file, and no category removal/restructure.

- [ ] **Step 5: Run full local verification**

```bash
npx supabase db reset --local
npm run supabase:test
npx tsc --noEmit
npx eslint <every changed .ts/.tsx/.mjs file>
npx vitest run --reporter=json --outputFile=/private/tmp/b2c-ledger-final-vitest.json
node -e 'const r=require("/private/tmp/b2c-ledger-final-vitest.json"); console.log({files:r.numTotalTestSuites,tests:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests})'
git diff --check
```

Expected: local reset and all checks pass; final handoff reports exact baseline/final counts and timing medians.

- [ ] **Step 6: Commit evidence**

```bash
git add scripts/b2c-ledger-performance.mjs docs/performance/2026-09-15-b2c-ledger-keyset-results.md
git commit -m "docs: record B2C ledger performance evidence"
```
