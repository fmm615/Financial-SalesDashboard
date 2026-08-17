# B2C Finance Payment Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators review complete B2C workbook payment evidence before safely recording duplicate, date, and correction decisions.

**Architecture:** Extend the B2C Finance action read model with a safe evidence type and render it through one reusable payment-evidence component. A new Admin-only database function saves selected duplicate choices transactionally, so all selected decisions are recorded or none are.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest/Testing Library, Zod, Supabase/Postgres, Tailwind, lucide-react.

## Global Constraints

- B2C Finance only: do not change B2B, provider data, uploaded workbook rows, or posting rules.
- Only Administrators may see decision evidence or submit a decision.
- Missing source values say **Not provided**; never guess values or expose raw provider/card data.
- Every duplicate decision has an audit reason; a selected batch is all-or-nothing.
- Do not stage `tsconfig.tsbuildinfo`.

---

### Task 1: Add an atomic selected-duplicate decision API

**Files:**
- Create: `supabase/migrations/20260817113000_b2c_finance_selected_duplicate_decisions.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `src/lib/validation/b2c-finance-action-contracts.ts`
- Modify: `src/server/repositories/b2c-finance-action-repository.ts`
- Create: `src/app/api/admin/b2c/finance-actions/duplicates/selected/route.ts`
- Test: `tests/database-foundation.test.ts`
- Test: `tests/b2c-finance-action-api.test.ts`

**Interface:** The strict request has `{ decisions: Array<{ groupId: string; financeRowId: string }>; reason: string }`. The new RPC is `apply_b2c_finance_selected_duplicate_decisions(p_decisions jsonb, p_reason text) returns integer`.

- [ ] **Step 1: Write failing migration and API tests**

```ts
const sql = migration("20260817113000_b2c_finance_selected_duplicate_decisions.sql");
expect(sql).toContain("apply_b2c_finance_selected_duplicate_decisions");
expect(sql).toContain("The selected Finance row must belong to the duplicate group");
expect(sql).toContain("insert into public.b2c_reconciliation_decisions");
```

Also prove a Viewer receives `403` and an Admin route call sends the selected group/row IDs to the RPC.

- [ ] **Step 2: Run the tests to prove they fail**

Run: `npm test -- tests/database-foundation.test.ts tests/b2c-finance-action-api.test.ts`

Expected: FAIL because the migration, schema, and route do not exist.

- [ ] **Step 3: Implement the transactional database boundary**

Create a `security definer` function. Require `auth.uid()` and `public.is_admin()`, allow 1–200 unique group IDs, lock each unresolved `exact_duplicate_candidate` group, ensure the selected row belongs to it, then insert one canonical reconciliation decision. Any invalid item raises an exception, so the Postgres transaction writes no decision. Revoke public access and grant `authenticated` execution.

Add the generated function type, Zod schema, repository RPC method, and Admin-only route. Return only `{ decidedGroups }`.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/database-foundation.test.ts tests/b2c-finance-action-api.test.ts && npm run typecheck && git diff --check`

Commit: `feat(b2c): support selected Finance duplicate decisions`

### Task 2: Return the workbook facts needed to make each decision

**Files:**
- Modify: `src/server/services/b2c-finance-action-center.ts`
- Modify: `src/server/repositories/b2c-finance-action-repository.ts`
- Test: `tests/b2c-finance-action-center.test.ts`

**Interface:** Define `B2cFinanceSourceEvidence` with source tab/row, Date, Month/Year labels, amount, customer name/email/phone, category, membership type, payment method, status, note, and quality issues. Duplicate groups contain two of these rows; Date and correction action items contain one as `evidence`.

- [ ] **Step 1: Write failing evidence-mapping tests**

```ts
expect(overview.duplicateGroups[0]?.rows[0]).toMatchObject({
  sourceTab: "B2C", sourceRowNumber: 12, occurredOn: "2025-10-05",
  amountUsd: "475", paymentMethod: "Stripe", note: "Full payment",
});
expect(overview.items.find((item) => item.actionType === "correction")?.evidence)
  .toMatchObject({ customerName: "Reham Garash", amountUsd: "475" });
```

- [ ] **Step 2: Run the test to prove it fails**

Run: `npm test -- tests/b2c-finance-action-center.test.ts`

Expected: FAIL because current action items expose only row IDs and explanations.

- [ ] **Step 3: Implement the evidence read model**

Extend completed-import repository selects with only the named safe workbook columns. Map them once into `B2cFinanceSourceEvidence`; do not select `raw_payload`, Storage paths, card data, or provider IDs. Keep existing exact-pair and row-quality filters.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/b2c-finance-action-center.test.ts && npm run typecheck && git diff --check`

Commit: `feat(b2c): expose Finance payment review evidence`

### Task 3: Build the reviewable duplicate, Date, and correction screens

**Files:**
- Create: `src/features/b2c/b2c-finance-payment-evidence.tsx`
- Modify: `src/features/b2c/b2c-finance-duplicate-actions.tsx`
- Modify: `src/features/b2c/b2c-finance-data-quality-actions.tsx`
- Modify: `src/features/b2c/b2c-finance-action-module.tsx`
- Test: `tests/b2c-finance-action-ui.test.tsx`

**Interface:** `B2cFinancePaymentEvidence({ evidence, heading })` renders read-only source facts. `B2cFinanceDuplicateActions` stores `Record<groupId, financeRowId>` and submits the Task 1 request once.

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(screen.getByText("B2C row 12")).toBeInTheDocument();
expect(screen.getByText("B2C Cons row 33")).toBeInTheDocument();
expect(screen.getByText("rgarash@example.com")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Keep B2C" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Keep B2C Cons" })).toBeInTheDocument();
expect(screen.getByText("1 selected payment pair")).toBeInTheDocument();
```

Add one test that switches a choice and asserts the final API body uses that group’s selected `financeRowId`; add another proving a tied pair is not selected automatically.

- [ ] **Step 2: Run the UI test to prove it fails**

Run: `npm test -- tests/b2c-finance-action-ui.test.tsx`

Expected: FAIL because the existing UI groups all recommendations by source tab and hides individual evidence.

- [ ] **Step 3: Implement the pair queue**

Render one pair card per exact duplicate, with B2C and B2C Cons evidence side by side, a safe recommendation label, `Keep B2C`/`Keep B2C Cons` controls, and a deselect control. Preselect only a more-complete recommendation; ties require an explicit selection. Collapse details after the first few cards while retaining an accessible **Show payment details** control. Show selected/recommended/individual counts, then one reason, confirmation checkbox, and `Record selected duplicate decisions` button.

Submit one selected-decision request. On failure retain choices and show that source evidence was unchanged; on success refresh the overview.

Reuse the evidence component above the Date-authority action and correction forms. The Date evidence explicitly includes source Date, declared Month/Year, and issues; correction evidence remains read-only above editable verified values.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/b2c-finance-action-ui.test.tsx && npm run typecheck && npm run lint && git diff --check`

Commit: `feat(b2c): review Finance payment evidence before decisions`

### Task 4: Add the B2C Finance navigation entry

**Files:**
- Modify: `src/components/app-shell.tsx`
- Test: `tests/ui-system.test.tsx`

**Interface:** Add `{ href: "/admin/b2c-finance", label: "B2C Finance", icon: Landmark, group: "Operations", adminOnly: true }` directly after B2C reconciliation.

- [ ] **Step 1: Write failing Admin and Viewer navigation tests**

```tsx
expect(screen.getByRole("link", { name: "B2C Finance" })).toHaveAttribute("href", "/admin/b2c-finance");
expect(screen.queryByRole("link", { name: "B2C Finance" })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the test to prove it fails**

Run: `npm test -- tests/ui-system.test.tsx`

Expected: FAIL because the B2C Finance navigation item is absent.

- [ ] **Step 3: Add the admin-only Operations link and verify**

Run: `npm test -- tests/ui-system.test.tsx && npm run typecheck && git diff --check`

Commit: `feat(b2c): add Finance review navigation`

### Task 5: Full verification and handoff

**Files:** none unless a relevant test reveals a defect.

- [ ] **Step 1: Run the full relevant suite**

Run: `npm test -- tests/b2c-finance-action-center.test.ts tests/b2c-finance-action-ui.test.tsx tests/b2c-finance-action-api.test.ts tests/database-foundation.test.ts tests/ui-system.test.tsx && npm run typecheck && npm run lint && npm run build && git diff --check`

Expected: all pass. Do not commit generated `tsconfig.tsbuildinfo`.

- [ ] **Step 2: Push and give the manual database instruction**

Push `main`. Ask the user to run only `20260817113000_b2c_finance_selected_duplicate_decisions.sql` in Supabase, then refresh `/admin/b2c-finance`. The migration creates no ledger entries or decisions by itself.

## Plan self-review

- Task 1 covers atomic, auditable selection safety.
- Task 2 covers safe evidence data availability.
- Task 3 covers visible, controllable decisions for duplicates, Dates, and corrections.
- Task 4 covers the missing admin navigation entry.
- Task 5 verifies security, UI, types, lint, and production build.
