# B2C Finance Workspace and Adjustments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one Admin-only B2C Finance workspace where verified source decisions flow to one posting action and later posted-payment corrections are append-only ledger adjustments.

**Architecture:** The page keeps the existing `/admin/b2c-finance` route but renders one query-string-backed tab at a time. The existing staged-row overrides remain the source of truth before posting. A new protected database adjustment stream represents post-ledger amount/date corrections without changing the original B2C payment; the B2C dashboard repository reads that stream when calculating effective Finance payment values and periods.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind CSS, Vitest + Testing Library, Zod, Supabase PostgreSQL/RLS/RPCs.

## Global Constraints

- B2C Finance only. Do not change B2B tables, routes, UI, or calculations.
- The Payment Tracker workbook, Stripe, Tap, Apple, and bank sources are immutable evidence; no feature may write to a provider.
- Existing staged Finance corrections must flow to the existing idempotent `post_approved_b2c_finance_payments()` action; the browser never constructs a B2C payment.
- Posted B2C payments are immutable source records. A money/date correction creates linked append-only adjustment entries; it never overwrites the original payment.
- Every write is Admin-only through the request-scoped Supabase client, an authenticated Admin RPC, RLS, audit triggers, and a 3–1000 character reason.
- Store USD money as `numeric(20,6)`, business dates as `date`, timestamps as UTC `timestamptz`, and never treat missing data as zero.
- Preserve the existing private-evidence boundary. Only current safe typed Finance fields may reach this Admin UI.
- Do not stage or commit `tsconfig.tsbuildinfo`.

---

## File structure

- `supabase/migrations/20260817120000_b2c_finance_posted_ledger_adjustments.sql` — append-only Finance adjustment schema, RLS/audit policies, and protected RPCs/effective read view.
- `src/lib/validation/b2c-finance-action-contracts.ts` — Zod contracts for per-row Date confirmation and posted Finance adjustments.
- `src/server/repositories/b2c-finance-action-repository.ts` — safe overview queries and exact RPC calls for Finance actions/adjustments.
- `src/server/services/b2c-finance-action-center.ts` — plain-language work-queue and posted-adjustment domain models, including date plausibility classification.
- `src/app/api/admin/b2c/finance-actions/[rowId]/date/route.ts` — thin Admin-only per-row Date action boundary.
- `src/app/api/admin/b2c/finance-actions/[rowId]/posted-adjustment/route.ts` — thin Admin-only posted adjustment boundary.
- `src/features/b2c/b2c-finance-workspace-tabs.tsx` — accessible, URL-backed workspace navigation.
- `src/features/b2c/b2c-finance-date-check-actions.tsx` — individually reviewable Date checks with source evidence, reason, and a safe action.
- `src/features/b2c/b2c-finance-detail-correction-actions.tsx` — extracted staged-row detail correction UI.
- `src/features/b2c/b2c-finance-posted-adjustment-actions.tsx` — posted Finance history plus controlled adjustment form.
- `src/features/b2c/b2c-finance-action-module.tsx` — composition shell that renders only the active workspace panel.
- `src/features/b2c/b2c-finance-data-quality-actions.tsx` — remove after splitting its responsibilities into the Date and detail components.
- `src/server/repositories/b2c-dashboard-repository.ts` — incorporate linked Finance ledger adjustments into the effective B2C payment amount/date used by current dashboard calculations.
- `tests/b2c-finance-action-center.test.ts` — queue classification and posted-adjustment service behavior.
- `tests/b2c-finance-action-api.test.ts` — route authorization, contract validation, and RPC parameter tests.
- `tests/b2c-finance-action-ui.test.tsx` — tab navigation, individual Date controls, detail correction controls, and single ready-to-post path.
- `tests/b2c-dashboard-repository.test.ts` — effective Finance amount/date and period behavior with linked adjustments.
- `supabase/tests/database_foundation.test.sql` — local pgTAP assertions for append-only, actor, source link, idempotency, and adjustment arithmetic.
- `docs/ARCHITECTURE.md`, `docs/TESTING_STRATEGY.md`, `docs/INTEGRATIONS.md` — document the post-ledger Finance adjustment boundary and test coverage.

### Task 1: Model post-ledger Finance adjustments in the database

**Files:**
- Create: `supabase/migrations/20260817120000_b2c_finance_posted_ledger_adjustments.sql`
- Modify: `supabase/tests/database_foundation.test.sql`
- Test: `supabase/tests/database_foundation.test.sql`

**Consumes:** existing `b2c_finance_ledger_posts(finance_row_id,payment_id)`, immutable `b2c_payments`, `b2c_finance_effective_rows`, `financial_corrections`, `profiles`, `is_admin()`, and `write_audit_event()`.

**Produces:**
- `b2c_finance_ledger_adjustments` rows with `payment_id`, `finance_row_id`, `adjustment_request_id`, `entry_index`, `adjustment_kind`, `amount_delta_usd`, `occurred_on`, `reason`, `created_by`, and UTC timestamps.
- `apply_b2c_finance_posted_adjustment(uuid,date,numeric,text,text,uuid,text)` that returns the number of inserted adjustment entries.
- `get_b2c_finance_posted_adjustments()` as an Admin-only safe projection for the workspace and `b2c_finance_effective_ledger_entries` for effective Finance ledger facts.

- [ ] **Step 1: Write failing pgTAP assertions for append-only linked adjustments**

Add assertions that expect the new table/view/RPC and that document the required economic results:

```sql
select has_table('public', 'b2c_finance_ledger_adjustments');
select has_function('public', 'apply_b2c_finance_posted_adjustment', array['uuid','date','numeric','text','text','uuid','text']);
select col_is_pk('public', 'b2c_finance_ledger_adjustments', 'id');
select col_hasnt_default('public', 'b2c_finance_ledger_adjustments', 'created_by');
select throws_ok(
  $$ select public.apply_b2c_finance_posted_adjustment(null, '2025-10-05', 475, null, null, gen_random_uuid(), 'Finance verified the amendment.') $$,
  'Only an authenticated administrator can adjust a posted B2C Finance payment'
);
```

Include seeded Admin transaction assertions proving:

```sql
-- $500 on 2025-01-10 corrected to $450 on the same date yields one -50 entry.
-- $500 moved from 2025-01-10 to 2025-02-10 yields -500 and +500 entries.
-- Repeating the same adjustment_request_id adds no second economic adjustment.
-- An UPDATE or DELETE against an existing adjustment is rejected.
```

- [ ] **Step 2: Run the local database suite to verify the assertions fail because the schema is absent**

Run: `npm run supabase:test`

Expected: the new `has_table`, `has_function`, and adjustment assertions fail because `b2c_finance_ledger_adjustments` and its RPC do not exist.

- [ ] **Step 3: Add the migration with protected, append-only adjustment behavior**

Create the table with these database-enforced fields and constraints:

```sql
create table public.b2c_finance_ledger_adjustments (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.b2c_payments(id) on delete restrict,
  finance_row_id uuid not null references public.b2c_finance_staging_rows(id) on delete restrict,
  adjustment_request_id uuid not null,
  entry_index smallint not null check (entry_index in (1, 2)),
  adjustment_kind text not null check (adjustment_kind in ('amount_correction', 'date_reclassification', 'amount_and_date_correction')),
  amount_delta_usd numeric(20, 6) not null check (amount_delta_usd <> 0),
  occurred_on date not null,
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (payment_id, adjustment_request_id, entry_index)
);
```

Enable RLS, permit only Admin reads, revoke direct browser insert/update/delete privileges, attach the existing audit trigger, and add a trigger rejecting `UPDATE` and `DELETE`.

Implement `apply_b2c_finance_posted_adjustment` as a `security definer` function with `set search_path = public`. It must:

1. require `auth.uid()` and `is_admin()`;
2. lock the matching `b2c_finance_ledger_posts` and `b2c_payments` rows;
3. require a USD `finance_tracker` payment with a complete completed Payment Tracker source;
4. derive the current effective amount and business date from the original payment plus existing linked adjustments;
5. validate that at least an amount or Date truly changes and the resulting amount is positive;
6. insert one same-date delta entry, or two ordered entries for a Date move;
7. insert one `financial_corrections` audit record with before/after JSON and the supplied reason;
8. return zero for the same idempotency request without changing the ledger.

The `b2c_finance_effective_ledger_entries` view must union the original `finance_tracker` payment with its linked signed adjustments so readers can sum by business date without mutating `b2c_payments`.

- [ ] **Step 4: Run the local database suite to verify the migration behavior passes**

Run: `npm run supabase:reset && npm run supabase:test`

Expected: the new adjustment assertions pass, including one-entry amount corrections, two-entry date moves, repeat-request idempotency, append-only protection, and Admin enforcement.

- [ ] **Step 5: Commit the database foundation**

```bash
git add supabase/migrations/20260817120000_b2c_finance_posted_ledger_adjustments.sql supabase/tests/database_foundation.test.sql
git commit -m "feat(b2c): add audited Finance ledger adjustments"
```

### Task 2: Add safe Finance adjustment contracts, repository methods, and Admin routes

**Files:**
- Modify: `src/lib/validation/b2c-finance-action-contracts.ts`
- Modify: `src/server/repositories/b2c-finance-action-repository.ts`
- Modify: `src/server/services/b2c-finance-action-center.ts`
- Create: `src/app/api/admin/b2c/finance-actions/[rowId]/date/route.ts`
- Create: `src/app/api/admin/b2c/finance-actions/[rowId]/posted-adjustment/route.ts`
- Modify: `tests/b2c-finance-action-api.test.ts`
- Modify: `tests/b2c-finance-action-center.test.ts`

**Consumes:** Task 1 RPC/view and existing action-center source evidence/repository patterns.

**Produces:**
- `b2cFinanceSingleDateAuthoritySchema` accepting one UUID plus a meaningful reason.
- `b2cFinancePostedAdjustmentSchema` accepting an optional verified `occurredOn`, optional positive `amountUsd`, a UUID `requestId`, and reason, with at least one financial value required.
- `B2cFinanceActionOverview.counts` extended with ready-to-post and posted-adjustment counts, plus typed posted Finance adjustment history.
- Admin-only `POST` routes that validate inputs then make one repository RPC call.

- [ ] **Step 1: Write failing contract and route tests**

Add tests that exercise real route behavior rather than mocking validation:

```ts
it("rejects a posted adjustment without a value change before the database call", async () => {
  const response = await applyPostedAdjustment(request({ requestId, reason: "Finance verified the corrected payment." }), params(rowId));
  expect(response.status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
});

it("requires Admin access before it confirms one Finance date", async () => {
  getApprovedRoleMock.mockResolvedValue("viewer");
  const response = await applyOneDateAuthority(request({ reason: "Finance checked the signed tracker." }), params(rowId));
  expect(response.status).toBe(403);
});
```

Add action-center tests showing a Date with a year outside `2000..2100` becomes a correction item rather than a safe Date-authority item, and showing a posted adjustment count/history is returned only from safe repository data.

- [ ] **Step 2: Run the focused tests to verify they fail for missing contracts/routes/classification**

Run: `npm test -- tests/b2c-finance-action-api.test.ts tests/b2c-finance-action-center.test.ts`

Expected: failures identify missing posted-adjustment route/schema and the old Date-authority classification.

- [ ] **Step 3: Implement the minimal typed boundary**

Add these exact public shapes:

```ts
export const b2cFinanceSingleDateAuthoritySchema = z.object({
  reason: decisionReason,
}).strict();

export const b2cFinancePostedAdjustmentSchema = z.object({
  occurredOn: isoDate.optional(),
  amountUsd: positiveUsd.optional(),
  requestId: z.string().uuid("Start the adjustment again."),
  reason: decisionReason,
}).strict().refine((value) => Boolean(value.occurredOn || value.amountUsd), {
  message: "Enter a verified amount or reporting date.",
});
```

Give the repository `applySingleDateAuthority(financeRowId, input)`, `applyPostedAdjustment(financeRowId, input)`, and `listPostedAdjustmentHistory()`. Each method calls its one named RPC and rejects malformed/no-data responses.

In `createB2cFinanceActionCenter`, make `isDateAuthorityCandidate` require a readable Date in the inclusive `2000..2100` year range and only month/year-label conflicts. Keep any other date—including `2922-09-27`—in the ordinary correction queue with the explanation `The workbook Date needs Finance verification before it can be used.`

Each route follows the existing `getApprovedRole` and request-scoped client pattern. It returns a safe 403/422/200 response and never includes database error internals.

- [ ] **Step 4: Run the focused tests to verify the new boundary passes**

Run: `npm test -- tests/b2c-finance-action-api.test.ts tests/b2c-finance-action-center.test.ts`

Expected: all focused tests pass, including Viewer rejection, invalid body rejection, plausible-Date classification, and RPC parameter shape.

- [ ] **Step 5: Commit the service and route boundary**

```bash
git add src/lib/validation/b2c-finance-action-contracts.ts src/server/repositories/b2c-finance-action-repository.ts src/server/services/b2c-finance-action-center.ts src/app/api/admin/b2c/finance-actions/[rowId]/date/route.ts src/app/api/admin/b2c/finance-actions/[rowId]/posted-adjustment/route.ts tests/b2c-finance-action-api.test.ts tests/b2c-finance-action-center.test.ts
git commit -m "feat(b2c): add safe Finance adjustment actions"
```

### Task 3: Make current B2C ledger calculations consume Finance adjustments

**Files:**
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `tests/b2c-dashboard-repository.test.ts`

**Consumes:** Task 1 `b2c_finance_effective_ledger_entries` and existing local override/FX/reportability rules.

**Produces:** Finance-tracker payment rows in the current B2C dashboard snapshot use the effective amount/date from the adjustment stream, while Stripe/Tap/manual/foreign-currency behavior remains unchanged.

- [ ] **Step 1: Write failing dashboard repository tests for amount and date adjustments**

Extend the repository client fixture with `b2c_finance_effective_ledger_entries` rows and prove the public snapshot calculations use them:

```ts
it("uses a linked Finance adjustment delta in the B2C net amount", async () => {
  // Base Finance payment: 500 USD on 2025-01-10; linked adjustment: -50 USD.
  expect(snapshot.totalRevenueUsd).toBe("450.00");
});

it("moves a Finance amount between months through its paired ledger adjustments", async () => {
  // -500 on 2025-01-10 and +500 on 2025-02-10.
  expect(january.totalRevenueUsd).toBe("0.00");
  expect(february.totalRevenueUsd).toBe("500.00");
});
```

Assert that a Stripe payment, Tap evidence, provider refund, and a non-USD payment remain governed by their existing paths.

- [ ] **Step 2: Run the focused test to verify it fails because adjustments are not loaded**

Run: `npm test -- tests/b2c-dashboard-repository.test.ts`

Expected: the new Finance adjustment expectations fail while existing B2C paths remain unchanged.

- [ ] **Step 3: Implement the effective Finance overlay in the repository**

Fetch `b2c_finance_effective_ledger_entries` with the existing parallel B2C reads. Build a `Map<paymentId, { amountUsd: string; occurredOn: string }>` by summing each payment’s base entry and adjustment entries with `toScaledUsd`. In `effectivePayment`, use this map only when `payment.source_system === "finance_tracker"`; then apply the existing local classification/contact override without replacing the adjustment-derived money/date. Preserve the current foreign-currency guard, provider refund logic, reportability gates, and source USD totals.

- [ ] **Step 4: Run the focused test to verify the dashboard calculations pass**

Run: `npm test -- tests/b2c-dashboard-repository.test.ts`

Expected: Finance amount/date corrections affect the intended reporting period and all existing source rules retain their expected behavior.

- [ ] **Step 5: Commit the effective-ledger reader**

```bash
git add src/server/repositories/b2c-dashboard-repository.ts tests/b2c-dashboard-repository.test.ts
git commit -m "feat(b2c): apply Finance ledger adjustments to dashboard data"
```

### Task 4: Replace the long B2C Finance page with one navigable work queue

**Files:**
- Create: `src/features/b2c/b2c-finance-workspace-tabs.tsx`
- Create: `src/features/b2c/b2c-finance-date-check-actions.tsx`
- Create: `src/features/b2c/b2c-finance-detail-correction-actions.tsx`
- Create: `src/features/b2c/b2c-finance-posted-adjustment-actions.tsx`
- Modify: `src/features/b2c/b2c-finance-action-module.tsx`
- Modify: `src/features/b2c/b2c-finance-duplicate-actions.tsx`
- Delete: `src/features/b2c/b2c-finance-data-quality-actions.tsx`
- Modify: `tests/b2c-finance-action-ui.test.tsx`

**Consumes:** Task 2 safe action models/routes and Task 3 corrected B2C ledger semantics.

**Produces:** query-string-backed tabs `queue`, `duplicates`, `dates`, `details`, `ready`, and `adjustments`; a single posting destination; individual source-evidence decisions; accessible feedback after every saved action.

- [ ] **Step 1: Write failing UI tests for the one-flow workspace**

Add tests that verify user-visible behavior:

```tsx
it("shows only the selected workspace section and keeps ready-to-post separate from correction work", async () => {
  render(<B2cFinanceActionModule />);
  expect(await screen.findByRole("tab", { name: /work queue/i })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: /date checks/i }));
  expect(screen.getByRole("heading", { name: /date checks/i })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /duplicate payments/i })).not.toBeInTheDocument();
});

it("requires a per-row reason before accepting one plausible source date", () => {
  render(<B2cFinanceDateCheckActions overview={overview} onChanged={vi.fn()} />);
  expect(screen.getByRole("button", { name: /confirm date for B2C row 12/i })).toBeDisabled();
});

it("keeps an implausible parsed date in the Fix details tab", () => {
  render(<B2cFinanceDetailCorrectionActions overview={implausibleDateOverview} onChanged={vi.fn()} />);
  expect(screen.getByText(/year in the workbook date needs Finance verification/i)).toBeInTheDocument();
});
```

Add a posted-adjustment UI test that enters a verified amount/reason, sends a generated request ID once, and shows the safe success message without claiming that the original payment changed.

- [ ] **Step 2: Run the focused UI test to verify it fails for missing workspace components**

Run: `npm test -- tests/b2c-finance-action-ui.test.tsx`

Expected: the test fails because no tab list, individual Date component, or posted-adjustment component exists.

- [ ] **Step 3: Implement small, focused workspace components**

Implement `B2cFinanceWorkspaceTabs` with semantic `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, visible focus styles, and URLs such as `/admin/b2c-finance?section=dates`. Use `window.history.replaceState` after selection so no business state lives in the URL beyond the active panel.

Split current `B2cFinanceDataQualityActions` into:

- `B2cFinanceDateCheckActions`: one evidence card at a time, individual reason state keyed by Finance row ID, `Confirm Date for {tab} row {row}` button, and a correction link/panel for implausible values. Remove the current `Use the verified Date for N payments` batch action.
- `B2cFinanceDetailCorrectionActions`: preserve the existing staged-row correction inputs, source evidence, and response handling without rendering Date-authority cards.
- `B2cFinancePostedAdjustmentActions`: show linked original payment facts and adjustment history. The form only asks for a corrected amount and/or reporting date plus reason; `crypto.randomUUID()` supplies one request ID per submission attempt. It explains whether one amount entry or two date-move entries will be created and retains form data after a failed request.

Refactor `B2cFinanceActionModule` to render the summary/work queue by default and exactly one selected panel. Keep `B2cApprovedFinancePosting` only inside **Ready to post**. Its existing successful refresh makes newly resolved source rows appear there automatically.

- [ ] **Step 4: Run the focused UI test to verify the workspace passes**

Run: `npm test -- tests/b2c-finance-action-ui.test.tsx`

Expected: tab semantics, one-panel rendering, per-row Date confirmation, correction evidence, posted-adjustment form, and the single posting journey pass.

- [ ] **Step 5: Commit the B2C Finance workspace UI**

```bash
git add src/features/b2c/b2c-finance-workspace-tabs.tsx src/features/b2c/b2c-finance-date-check-actions.tsx src/features/b2c/b2c-finance-detail-correction-actions.tsx src/features/b2c/b2c-finance-posted-adjustment-actions.tsx src/features/b2c/b2c-finance-action-module.tsx src/features/b2c/b2c-finance-duplicate-actions.tsx src/features/b2c/b2c-finance-data-quality-actions.tsx tests/b2c-finance-action-ui.test.tsx
git commit -m "feat(b2c): organize Finance work into one workspace"
```

### Task 5: Document the boundary and complete full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/INTEGRATIONS.md`
- Test: all existing test, type, lint, build, and local database commands

**Consumes:** Tasks 1–4.

**Produces:** documentation accurately states that Finance adjustments are local, append-only, and included in effective B2C ledger reporting; fresh end-to-end verification evidence.

- [ ] **Step 1: Update the documented B2C Finance boundary and test requirements**

Add concise statements that Finance source corrections before posting change the effective staged row; posted amount/date corrections create linked adjustment entries; source payments remain immutable; and B2C reporting reads the effective base-plus-adjustment stream. Add required test coverage for period moves, retry idempotency, and no provider/B2B mutation.

- [ ] **Step 2: Run every application verification command**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: each command exits zero. Record the exact passing test-file/test count and confirm no TypeScript, ESLint, or production-build errors.

- [ ] **Step 3: Run the database verification after applying the new migration locally**

Run:

```bash
npm run supabase:reset
npm run supabase:test
```

Expected: database assertions, including Finance adjustment arithmetic/idempotency/append-only checks, pass.

- [ ] **Step 4: Review the implementation against the approved design**

Check each approved requirement against Tasks 1–4: B2C-only scope, internal navigation, one posting action, source evidence, individual Date decisions, immutable posted payments, linked adjustments, effective ledger/reporting values, audit/RLS, safe errors, and no provider writes. Inspect `git diff --check` and `git status --short`; keep `tsconfig.tsbuildinfo` unstaged.

- [ ] **Step 5: Commit documentation and verification-ready implementation**

```bash
git add docs/ARCHITECTURE.md docs/TESTING_STRATEGY.md docs/INTEGRATIONS.md
git commit -m "docs(b2c): document Finance adjustment controls"
```
