# Admin Action Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single Admin Action Center that shows every actionable financial issue and safely resolves the current B2C Finance workbook decisions.

**Architecture:** The Action Center aggregates authoritative workflows and never becomes a shadow ledger or flag system. A separate immutable B2C Finance override layer keeps source workbook evidence untouched while storing corrected effective values and audit journal entries for posting.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind, Supabase PostgreSQL/RLS/RPC, Zod, Vitest, Testing Library, Lucide.

## Global Constraints

- Work on `main` and push only to `https://github.com/fmm615/Financial-SalesDashboard.git` as authorised by the user.
- Never stage `tsconfig.tsbuildinfo`.
- Write and run a failing test before each production behaviour change.
- Every mutation requires an authenticated administrator and a meaningful reason.
- Source workbooks, provider evidence, provider data, flags, ledger rows, corrections, and audit history are never deleted or overwritten.
- B2C and B2B are always separate; B2B bookings and recognised sales are never combined.
- Do not introduce a provider write operation, automatic report email, or an unverified financial total.
- Commit and push every independently working task, then report the commit message to the user.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql` | Finance correction overlays, Date-authority decisions, effective-row view, bulk duplicate decisions, and the updated posting RPC |
| `src/lib/validation/b2c-finance-action-contracts.ts` | Zod input contracts for B2C Finance actions |
| `src/server/repositories/b2c-finance-action-repository.ts` | Safe B2C Finance reads and RPC calls |
| `src/server/services/b2c-finance-action-center.ts` | Plain-language B2C Finance action grouping and counts |
| `src/app/api/admin/b2c/finance-actions/**/route.ts` | Admin-only B2C Finance action endpoints |
| `src/features/b2c/b2c-finance-action-module.tsx` | Focused B2C Finance resolution screen |
| `src/server/repositories/admin-action-center-repository.ts` | Reads action sources across B2C, B2B, reports, and integrations |
| `src/server/services/admin-action-center.ts` | Normalises authoritative source states into Action Center items |
| `src/app/api/admin/action-center/route.ts` | Admin-only Action Center API |
| `src/features/admin/admin-action-center-page.tsx` | Hub summary, queue, filters, quick actions, and module cards |
| `src/app/admin/b2c-finance/page.tsx` | B2C Finance module route |
| `src/app/admin/integrations/page.tsx` | Focused integration recovery route |
| `src/components/app-shell.tsx` | One Admin Action Center navigation item |
| `tests/b2c-finance-action-*.test.*` | B2C action service, API, and UI tests |
| `tests/admin-action-center*.test.*` | Cross-module aggregation, API, and UI tests |

## Task 1: Create immutable B2C Finance corrections and effective values

**Files:**

- Create: `supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `tests/database-foundation.test.ts`

**Consumes:** `b2c_finance_staging_rows`, reconciliation groups, `financial_corrections`, and the existing admin/audit triggers.

**Produces:** An immutable correction history plus a single effective-row view for all later B2C Finance posting logic.

- [x] **Step 1: Write the failing migration contract**

```ts
it("keeps Finance source rows immutable while allowing an audited effective override", () => {
  const sql = migration("20260817110000_b2c_finance_action_resolutions.sql");
  expect(sql).toContain("create table public.b2c_finance_row_overrides");
  expect(sql).toContain("create view public.b2c_finance_effective_rows");
  expect(sql).toContain("insert into public.financial_corrections");
  expect(sql).not.toMatch(/update public\.b2c_finance_staging_rows\s+set/i);
});
```

- [x] **Step 2: Run the test and observe RED**

Run: `npm test -- tests/database-foundation.test.ts`

Expected: the test fails because the migration file does not exist.

- [x] **Step 3: Add the minimal database model**

Create a `b2c_finance_row_overrides` table keyed by Finance staging row ID. Permit only verified effective `occurred_on`, `amount_usd`, `customer_name`, and `category_raw` values, plus `date_authority_confirmed_at`, actor/time columns, and validation that either at least one data field changes or Date-authority is confirmed.

Add `apply_b2c_finance_row_correction(p_finance_row_id uuid, p_occurred_on date, p_amount_usd numeric, p_customer_name text, p_category_raw text, p_reason text)`. It must lock the source row, reject already-posted rows and no-op changes, upsert an overlay, and append a `financial_corrections` record for every changed field. Extend the correction target-area constraint to include `b2c_finance_row`.

Add `apply_b2c_finance_date_authority(p_finance_row_ids uuid[], p_reason text)`. It accepts only valid main Dates whose sole issue is a Month/Year label conflict, marks Date-authority as confirmed while preserving the parsed source Date, writes a non-identical before/after correction journal describing the conflicting labels and accepted Date, and rejects empty, duplicate, or non-eligible IDs.

Create `b2c_finance_effective_rows`. It coalesces overlay values with raw staging values and exposes `effective_quality`; a valid Date with an audited Date-authority decision becomes effective `valid` without hiding its raw source issue.

- [x] **Step 4: Update generated types**

Run `npm run supabase:types` if the local Supabase stack is available; otherwise update `src/types/database.generated.ts` mechanically for the new table, view, and RPCs.

- [x] **Step 5: Run the test and observe GREEN**

Run: `npm test -- tests/database-foundation.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql src/types/database.generated.ts tests/database-foundation.test.ts
git commit -m "feat(b2c): add audited Finance staging corrections"
```

## Task 2: Post only resolved effective Finance records

**Files:**

- Modify: `supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql`
- Modify: `tests/approved-finance-payment.test.ts`
- Modify: `tests/database-foundation.test.ts`

**Consumes:** `b2c_finance_effective_rows` from Task 1 and the existing idempotent `b2c_finance_ledger_posts` relationship.

**Produces:** A posting transaction that uses corrected effective values, accepts Date-authority decisions, and keeps non-canonical duplicates out.

- [x] **Step 1: Write the failing posting tests**

```ts
it("posts only valid effective Finance rows while retaining duplicate controls", () => {
  const sql = migration("20260817110000_b2c_finance_action_resolutions.sql");
  expect(sql).toContain("from public.b2c_finance_effective_rows rows");
  expect(sql).toContain("rows.effective_quality = 'valid'");
  expect(sql).toContain("groups.reconciliation_state <> 'canonical' or groups.canonical_finance_row_id <> rows.id");
});
```

- [x] **Step 2: Run the test and observe RED**

Run: `npm test -- tests/approved-finance-payment.test.ts tests/database-foundation.test.ts`

Expected: the new effective-row behaviour fails because posting still reads raw `row_quality` and raw fields.

- [x] **Step 3: Replace the posting RPC in the new migration**

Use `create or replace function public.post_approved_b2c_finance_payments()` in the new migration. Select from `b2c_finance_effective_rows`, retain the mixed-case Bank Transfer/iOS normalisation, require effective positive amount/date/category, keep the exact ledger-post idempotency check, and retain the canonical-group rule.

Store the source Finance row ID, raw source tab/row number, and effective values used in `b2c_payments.source_metadata`. Never modify an already posted payment.

- [x] **Step 4: Run the test and observe GREEN**

Run: `npm test -- tests/approved-finance-payment.test.ts tests/database-foundation.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql tests/approved-finance-payment.test.ts tests/database-foundation.test.ts
git commit -m "feat(b2c): post resolved Finance evidence safely"
```

## Task 3: Add proven bulk B2C duplicate decisions

**Files:**

- Create: `src/lib/validation/b2c-finance-action-contracts.ts`
- Create: `src/server/repositories/b2c-finance-action-repository.ts`
- Create: `src/app/api/admin/b2c/finance-actions/duplicates/bulk-canonical/route.ts`
- Modify: `supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql`
- Create: `tests/b2c-finance-action-center.test.ts`
- Create: `tests/b2c-finance-action-api.test.ts`

**Consumes:** Exact duplicate reconciliation groups and decisions.

**Produces:** One confirmed action that writes individual canonical decisions only for exact groups with a provable more-complete source row.

- [ ] **Step 1: Write failing recommendation and API tests**

```ts
it("recommends B2C Cons only when it has more usable fields", () => {
  expect(getCanonicalRecommendation(completeB2cConsPair)).toMatchObject({ sourceTab: "B2C Cons", eligibleForBulk: true });
  expect(getCanonicalRecommendation(equalPair)).toMatchObject({ eligibleForBulk: false });
});

it("rejects a bulk decision without a meaningful reason", async () => {
  expect((await POST(request({ groupIds: ids, sourceTab: "B2C Cons", reason: "" }))).status).toBe(422);
});
```

- [ ] **Step 2: Run the tests and observe RED**

Run: `npm test -- tests/b2c-finance-action-center.test.ts tests/b2c-finance-action-api.test.ts`

Expected: FAIL because the service, route, and RPC do not exist.

- [ ] **Step 3: Add recommendation and mutation paths**

Add `apply_b2c_finance_bulk_canonical_decision(p_group_ids uuid[], p_source_tab text, p_reason text)`. It must lock each group, require exactly two members (one B2C and one B2C Cons), require unresolved exact-duplicate state, calculate completeness from approved business fields, reject ambiguous groups, and insert one audited canonical decision per eligible group.

Validate `groupIds`, `sourceTab`, and `reason` with Zod. The API must require admin access and return a safe, plain-language error without customer data.

- [ ] **Step 4: Run the tests and observe GREEN**

Run: `npm test -- tests/b2c-finance-action-center.test.ts tests/b2c-finance-action-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260817110000_b2c_finance_action_resolutions.sql src/lib/validation/b2c-finance-action-contracts.ts src/server/repositories/b2c-finance-action-repository.ts src/app/api/admin/b2c/finance-actions/duplicates/bulk-canonical/route.ts tests/b2c-finance-action-center.test.ts tests/b2c-finance-action-api.test.ts
git commit -m "feat(b2c): bulk resolve proven Finance duplicates"
```

## Task 4: Expose B2C Finance actions through a focused module API

**Files:**

- Create: `src/server/services/b2c-finance-action-center.ts`
- Create: `src/app/api/admin/b2c/finance-actions/route.ts`
- Create: `src/app/api/admin/b2c/finance-actions/date-authority/route.ts`
- Create: `src/app/api/admin/b2c/finance-actions/[rowId]/correction/route.ts`
- Modify: `src/server/repositories/b2c-finance-action-repository.ts`
- Modify: `src/lib/validation/b2c-finance-action-contracts.ts`
- Modify: `tests/b2c-finance-action-center.test.ts`
- Modify: `tests/b2c-finance-action-api.test.ts`

**Consumes:** Tasks 1–3.

**Produces:** A safe action-level overview and three admin-only B2C mutation endpoints.

- [ ] **Step 1: Write failing service tests**

```ts
it("shows one duplicate decision for two retained Finance rows", async () => {
  const overview = await createB2cFinanceActionCenter(repository).overview();
  expect(overview.counts).toMatchObject({ duplicateDecisions: 1, duplicateSourceRows: 2 });
});

it("labels a valid Date with conflicting Month/Year as a Date-authority action", async () => {
  const overview = await createB2cFinanceActionCenter(repository).overview();
  expect(overview.items).toContainEqual(expect.objectContaining({ actionLabel: "Use verified Date" }));
});
```

- [ ] **Step 2: Run the test and observe RED**

Run: `npm test -- tests/b2c-finance-action-center.test.ts`

Expected: FAIL because the B2C Finance action service does not exist.

- [ ] **Step 3: Implement the overview and endpoints**

Expose only action-safe fields: source tab, workbook row number, issue explanation, effective readiness, and canonical recommendation. Do not expose raw sensitive payment data in the list.

The Date-authority route accepts eligible row IDs and a reason. The correction route accepts a UUID and validated amount/date/name/category changes plus a reason. Both authorise admin access before invoking the Task 1 RPCs and return updated safe counts.

- [ ] **Step 4: Run tests and observe GREEN**

Run: `npm test -- tests/b2c-finance-action-center.test.ts tests/b2c-finance-action-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/b2c-finance-action-center.ts src/server/repositories/b2c-finance-action-repository.ts src/lib/validation/b2c-finance-action-contracts.ts src/app/api/admin/b2c/finance-actions tests/b2c-finance-action-center.test.ts tests/b2c-finance-action-api.test.ts
git commit -m "feat(b2c): expose Finance resolution actions"
```

## Task 5: Build the B2C Finance resolution screen

**Files:**

- Create: `src/features/b2c/b2c-finance-action-module.tsx`
- Create: `src/features/b2c/b2c-finance-duplicate-actions.tsx`
- Create: `src/features/b2c/b2c-finance-data-quality-actions.tsx`
- Create: `src/app/admin/b2c-finance/page.tsx`
- Modify: `src/features/b2c/b2c-approved-finance-posting.tsx`
- Create: `tests/b2c-finance-action-ui.test.tsx`
- Modify: `tests/approved-finance-payment-ui.test.tsx`

**Consumes:** Task 4 overview/mutation APIs and the existing posting component.

**Produces:** A simple B2C Finance workspace for 43 duplicate decisions, ten Date-label decisions, five required corrections, and safe ledger posting.

- [ ] **Step 1: Write failing UI tests**

```tsx
it("shows 43 duplicate decisions instead of 86 source rows", async () => {
  render(<B2cFinanceActionModule />);
  expect(await screen.findByText("43 duplicate decisions")).toBeInTheDocument();
});

it("requires a reason before applying a recommended duplicate decision", () => {
  render(<B2cFinanceDuplicateActions recommendation={recommendation} />);
  expect(screen.getByRole("button", { name: "Use B2C Cons for 43 payments" })).toBeDisabled();
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/b2c-finance-action-ui.test.tsx tests/approved-finance-payment-ui.test.tsx`

Expected: FAIL because the module and controls do not exist.

- [ ] **Step 3: Implement the three-card workflow**

Render, in order:

1. **Duplicate payments**: one decision per pair, recommendation, mandatory reason, confirmation, bulk action only for server-approved groups, and an individual fallback.
2. **Information to correct**: a Date-authority group action, then individual forms for unreadable dates, missing names, amount, and category. Show raw source and effective values separately.
3. **Ready to add**: current ledger count, newly eligible count, intentional duplicate copies excluded, and the idempotent posting action.

Use existing `SectionCard`, `PrimaryButton`, labelled fields, disabled saving states, and `role="alert"` errors. Link to source-file intake rather than duplicating upload controls.

- [ ] **Step 4: Run tests and observe GREEN**

Run: `npm test -- tests/b2c-finance-action-ui.test.tsx tests/approved-finance-payment-ui.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/b2c/b2c-finance-action-module.tsx src/features/b2c/b2c-finance-duplicate-actions.tsx src/features/b2c/b2c-finance-data-quality-actions.tsx src/app/admin/b2c-finance/page.tsx src/features/b2c/b2c-approved-finance-posting.tsx tests/b2c-finance-action-ui.test.tsx tests/approved-finance-payment-ui.test.tsx
git commit -m "feat(admin): add B2C Finance resolution module"
```

## Task 6: Aggregate all live action sources for the Action Center

**Files:**

- Create: `src/server/repositories/admin-action-center-repository.ts`
- Create: `src/server/services/admin-action-center.ts`
- Create: `src/app/api/admin/action-center/route.ts`
- Create: `tests/admin-action-center.test.ts`
- Create: `tests/admin-action-center-api.test.ts`

**Consumes:** Review flags, Task 4 B2C Finance actions, integration errors/runs, report jobs, and target data.

**Produces:** An admin-only action-level queue with one shape and no shadow table.

- [ ] **Step 1: Write failing aggregation tests**

```ts
it("combines B2C decisions, flags, integration failures, and report failures in financial-impact order", async () => {
  const result = await createAdminActionCenter(repository).list({ status: "open" });
  expect(result.items.map((item) => item.category)).toEqual(["revenue_blocker", "duplicate", "process_failure"]);
});

it("requires an administrator to load the Action Center", async () => {
  expect((await GET(unauthenticatedRequest)).status).toBe(403);
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/admin-action-center.test.ts tests/admin-action-center-api.test.ts`

Expected: FAIL because the aggregation service and route do not exist.

- [ ] **Step 3: Implement source adapters**

Use one `AdminActionItem` type with module, category, status, title, explanation, impact, action label, route, and created time. Map B2C Finance to `/admin/b2c-finance`; B2B flags to `/operations/b2b`; B2C/payment/product flags to `/operations/b2c`; integrations to `/admin/integrations`; reports to `/reports`; targets to `/finance/targets`; and history to `/audit-log`.

Deduplicate an item if the B2C Finance module already represents the same source decision. Return metrics for revenue blockers, open decisions, failed processes, and resolved today.

- [ ] **Step 4: Run tests and observe GREEN**

Run: `npm test -- tests/admin-action-center.test.ts tests/admin-action-center-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/repositories/admin-action-center-repository.ts src/server/services/admin-action-center.ts src/app/api/admin/action-center/route.ts tests/admin-action-center.test.ts tests/admin-action-center-api.test.ts
git commit -m "feat(admin): aggregate actionable finance work"
```

## Task 7: Build the Action Center hub and consolidate navigation

**Files:**

- Create: `src/features/admin/admin-action-center-page.tsx`
- Modify: `src/app/admin/page.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/app/review-queue/page.tsx`
- Modify: `src/app/operations/b2c/reconciliation/page.tsx`
- Create: `tests/admin-action-center-ui.test.tsx`
- Modify: `tests/ui-system.test.tsx`

**Consumes:** Task 6 Action Center API and Task 5 B2C route.

**Produces:** One easy-to-find admin front door without dead bookmarks.

- [ ] **Step 1: Write failing navigation/UI tests**

```tsx
it("shows one Admin Action Center navigation item for administrators", () => {
  render(<AppShell title="x" description="x">content</AppShell>);
  expect(screen.getByRole("link", { name: "Admin Action Center" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Review queue" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Administration" })).not.toBeInTheDocument();
});

it("opens B2C Finance from a revenue blocker", async () => {
  render(<AdminActionCenterPage />);
  expect(await screen.findByRole("link", { name: "Review B2C Finance" })).toHaveAttribute("href", "/admin/b2c-finance");
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/admin-action-center-ui.test.tsx tests/ui-system.test.tsx`

Expected: FAIL because the hub and consolidated navigation do not exist.

- [ ] **Step 3: Implement the hub**

Use the existing PLAYBOOK light card/table visual system. Render four filterable summary cards, then a queue with `Problem`, `Impact`, and `What to do`, then quick actions and module cards. Keep a queue item’s action as a link to the focused module, not an unsafe one-click mutation.

Replace the preview-only Administration page. Keep the old Review Queue and B2C Reconciliation routes valid by redirecting authorised admins to `/admin` and `/admin/b2c-finance`; preserve access-denied behaviour for viewers.

- [ ] **Step 4: Run tests and observe GREEN**

Run: `npm test -- tests/admin-action-center-ui.test.tsx tests/ui-system.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/admin/admin-action-center-page.tsx src/app/admin/page.tsx src/components/app-shell.tsx src/app/review-queue/page.tsx src/app/operations/b2c/reconciliation/page.tsx tests/admin-action-center-ui.test.tsx tests/ui-system.test.tsx
git commit -m "feat(admin): add unified Action Center hub"
```

## Task 8: Move existing live integration controls into their module and make all links truthful

**Files:**

- Create: `src/features/admin/integration-administration-panel.tsx`
- Create: `src/app/admin/integrations/page.tsx`
- Modify: `src/features/admin/admin-page.tsx`
- Modify: `src/features/admin/admin-action-center-page.tsx`
- Create: `tests/integration-administration-panel.test.tsx`
- Modify: `tests/integration-run-summary-ui.test.tsx`
- Modify: `tests/admin-action-center-ui.test.tsx`

**Consumes:** Existing real Stripe/Tap/HubSpot sync/backfill controls and existing B2B, B2C, targets, reports, mappings, and Audit Log routes.

**Produces:** An integrations module containing working controls and no Action Center button that falsely claims a preview form saves data.

- [ ] **Step 1: Write failing truthfulness and extraction tests**

```tsx
it("shows real provider status and backfill controls in the integrations module", () => {
  render(<IntegrationAdministrationPanel />);
  expect(screen.getByText("Integration status")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /historical Stripe import/i })).toBeInTheDocument();
});

it("does not show a fake save action for an unavailable module", async () => {
  render(<AdminActionCenterPage />);
  expect(await screen.findByText("Not available yet")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Review IBAN entry/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/integration-administration-panel.test.tsx tests/integration-run-summary-ui.test.tsx tests/admin-action-center-ui.test.tsx`

Expected: FAIL because the reusable module and truthful Action Center states do not exist.

- [ ] **Step 3: Extract live controls and link only to real workflows**

Move the existing working integration controls into `IntegrationAdministrationPanel` without altering provider behaviour. State explicitly that sync/backfill reads and reconciles; it does not write to Stripe, Tap, or HubSpot.

The Action Center links to the current live B2B, B2C, product-mapping, target, report, and audit screens. For a control with no authorised backend—currently manual bank transfer entry—show **Not available yet** with no mutation button. Do not retain the old preview-only Admin forms.

- [ ] **Step 4: Run tests and observe GREEN**

Run: `npm test -- tests/integration-administration-panel.test.tsx tests/integration-run-summary-ui.test.tsx tests/admin-action-center-ui.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/admin/integration-administration-panel.tsx src/app/admin/integrations/page.tsx src/features/admin/admin-page.tsx src/features/admin/admin-action-center-page.tsx tests/integration-administration-panel.test.tsx tests/integration-run-summary-ui.test.tsx tests/admin-action-center-ui.test.tsx
git commit -m "feat(admin): centralize live recovery controls"
```

## Task 9: Verify the rollout and document the required migration

**Files:**

- Modify: `docs/superpowers/specs/2026-08-17-admin-action-center-design.md`
- Modify: `docs/superpowers/plans/2026-08-17-admin-action-center.md`

**Consumes:** Tasks 1–8.

**Produces:** Full verification evidence and safe Supabase migration instructions.

- [ ] **Step 1: Add the final acceptance test**

```ts
it("retains the raw workbook row after a Finance correction while the effective row changes", async () => {
  await applyCorrection(correctableRow, "Verified Finance evidence");
  expect(await getRawSourceRow(correctableRow.id)).toEqual(originalSourceRow);
  expect(await getEffectiveFinanceRow(correctableRow.id)).toMatchObject({ occurredOn: "2025-10-05" });
});
```

- [ ] **Step 2: Run complete verification**

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.

Expected: all pass; no source evidence is changed; `tsconfig.tsbuildinfo` is not staged.

- [ ] **Step 3: Test the live admin workflow after applying the migration**

1. Open Admin Action Center as an administrator.
2. Open B2C Finance from its revenue-blocking action.
3. Apply the recommended B2C Cons duplicate decisions with a meaningful reason.
4. Apply Date-authority only to the valid-Date label conflicts with a meaningful reason.
5. Correct unreadable dates and missing name using verified Finance evidence.
6. Confirm raw workbook values remain visible in history.
7. Post verified Finance payments once, then repeat once to confirm idempotency.
8. Confirm duplicate copies are never added to the B2C ledger.

- [ ] **Step 4: Update rollout instructions**

Add the exact migration filename and user-facing test steps to the design document. Do not hard-code a final payment count because it depends on Finance’s verified corrections.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-17-admin-action-center-design.md docs/superpowers/plans/2026-08-17-admin-action-center.md
git commit -m "docs(admin): verify Action Center rollout"
```

## Plan self-review

- Tasks 1–5 cover the current B2C Finance source rows, 43 duplicate decisions, ten Date-label conflicts, five required corrections, and safe posting.
- Tasks 6–8 provide the single Admin Action Center, consolidated navigation, live integration module, and truthful links to B2B, B2C, mapping, reports, targets, and audit work.
- The plan never creates a shadow source of truth: it aggregates authoritative records and stores only auditable effective-value overlays.
- The plan intentionally does not invent a manual bank-transfer form because its final business fields and duplicate policy are not yet approved; the UI must state that honestly until a dedicated specification is approved.
