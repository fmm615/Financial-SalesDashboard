# B2C Exact-Duplicate Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin consolidate one exact `B2C`/`B2C Cons` Finance duplicate into one canonical candidate without publishing B2C revenue.

**Architecture:** A protected PostgreSQL function groups only unique, exact cross-tab pairs in one completed Payment Tracker import. Request-scoped Admin routes expose a minimal review model, and the UI uses the existing one-time audited decision endpoint. Nothing creates a B2C payment, total, target, report, or provider change.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Vitest, Zod, Supabase PostgreSQL/RLS, PostgreSQL audit triggers.

## Global Constraints

- Finance `B2C` and `B2C Cons` overlap and are never added together.
- A match needs one valid row from each tab, one completed workbook import, exact date, USD amount, category, payment method, and identity.
- Identity is equal normalized e-mail; only with both e-mails absent is equal normalized name and phone allowed.
- More than one matching row in either tab is ambiguous: create no group and make no automatic choice.
- Stripe/Tap are evidence only. Do not write `b2c_payments`, reportable views, targets, reports, or provider systems.
- All writes are request-scoped, Admin-only, RLS-protected, append-only/audited. A canonical/excluded decision always requires a reason.
- Viewers receive safe coverage only, never Finance rows, contacts, raw payloads, or controls.
- The user applies migrations manually; local pgTAP cannot run without a Supabase CLI.

## File Structure

- `supabase/migrations/20260812103000_b2c_exact_duplicate_groups.sql`: protected idempotent group creation.
- `src/types/database.generated.ts`: `grouping_key` and RPC contract.
- `src/server/services/b2c-exact-duplicate-reconciliation.ts`: pure eligibility/ambiguity rule.
- `src/server/repositories/b2c-exact-duplicate-reconciliation-repository.ts`: request-scoped DB reads/RPC call.
- `src/server/services/b2c-exact-duplicate-review.ts`: minimal Admin review projection.
- `src/app/api/admin/b2c/reconciliation/exact-duplicates/route.ts`: list API.
- `src/app/api/admin/b2c/reconciliation/exact-duplicates/group/route.ts`: grouping API.
- `src/features/b2c/b2c-exact-duplicate-review.tsx`: Admin review component.
- `src/features/b2c/b2c-reconciliation-page.tsx`: UI composition.
- `tests/b2c-exact-duplicate-reconciliation*.test.ts*`: pure, API, and UI tests.

### Task 1: Persist only exact, unambiguous Finance groups

**Files:**

- Create: `supabase/migrations/20260812103000_b2c_exact_duplicate_groups.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `tests/database-foundation.test.ts`
- Modify: `supabase/tests/database_foundation.test.sql`

**Interfaces:** Adds nullable `b2c_reconciliation_groups.grouping_key`, a partial unique index, and `create_b2c_exact_duplicate_groups() returns integer`.

- [ ] **Step 1: Write failing contract tests**

Add migration assertions:

```ts
expect(migration).toContain("add column grouping_key text");
expect(migration).toContain("create_b2c_exact_duplicate_groups()");
expect(migration).toContain("not public.is_admin()");
expect(migration).not.toContain("insert into public.b2c_payments");
```

Add pgTAP cases that reject a non-Admin call and reject duplicate non-null grouping keys.

- [ ] **Step 2: Verify the test fails**

Run `npm test -- tests/database-foundation.test.ts`. Expect failure because the migration does not exist.

- [ ] **Step 3: Create the migration**

Keep `grouping_key` nullable to preserve historical/manual groups. Add a partial unique index on non-null keys. Create this function:

```sql
create or replace function public.create_b2c_exact_duplicate_groups()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can group exact B2C Finance duplicates';
  end if;
  -- Insert unambiguous pairs, their group and exactly two Finance links.
end;
$$;
```

The CTE selects two `row_quality = 'valid'` rows from one completed `payment_tracker` import: left `B2C`, right `B2C Cons`; equal `occurred_on`, `amount_usd`, `lower(trim(category_raw))`, and `lower(trim(payment_method_raw))`; equal non-null e-mail, or if e-mail is null on both, equal non-null normalized name and phone. Group by normalized comparison key and retain only one B2C plus one B2C Cons row. Use a deterministic group key from sorted Finance row UUIDs, never customer data. Insert state `exact_duplicate_candidate`, link only those two Finance rows, and use conflict handling so reruns return zero new groups. Never link provider evidence.

Revoke function access from `public`, grant it to `authenticated`, and add the field/RPC type to the generated database contract.

- [ ] **Step 4: Verify the test passes**

Run `npm test -- tests/database-foundation.test.ts`. Expect pass; pgTAP stays committed for manual/CI Supabase execution.

- [ ] **Step 5: Commit**

Run `git add supabase/migrations/20260812103000_b2c_exact_duplicate_groups.sql src/types/database.generated.ts tests/database-foundation.test.ts supabase/tests/database_foundation.test.sql` and commit `feat(b2c): group exact Finance duplicates`.

### Task 2: Test the pure exact-pair rule

**Files:**

- Create: `src/server/services/b2c-exact-duplicate-reconciliation.ts`
- Create: `tests/b2c-exact-duplicate-reconciliation.test.ts`

**Interfaces:** `isExactFinanceCrossTabPair(left, right): boolean` and `isUnambiguousExactFinanceKey(rows): boolean`.

- [ ] **Step 1: Write failing unit tests**

```ts
expect(isExactFinanceCrossTabPair(b2cRow, b2cConsRow)).toBe(true);
expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, amountUsd: "476" })).toBe(false);
expect(isExactFinanceCrossTabPair(noEmailB2c, noEmailCons)).toBe(true);
expect(isExactFinanceCrossTabPair(noEmailB2c, { ...noEmailCons, normalizedCustomerPhone: null })).toBe(false);
expect(isUnambiguousExactFinanceKey([b2cRow, b2cConsRow])).toBe(true);
expect(isUnambiguousExactFinanceKey([b2cRow, b2cConsRow, anotherB2c])).toBe(false);
```

Also cover different imports, same tab, invalid quality, category/method/date/e-mail mismatch, recurring later payments, and same-day multiplicity.

- [ ] **Step 2: Verify the test fails**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation.test.ts`. Expect failure because the module is absent.

- [ ] **Step 3: Implement the focused rule**

```ts
export function isExactFinanceCrossTabPair(left: ExactFinanceRow, right: ExactFinanceRow): boolean {
  if (left.importId !== right.importId || left.quality !== "valid" || right.quality !== "valid") return false;
  if (new Set([left.sourceTab, right.sourceTab]).size !== 2) return false;
  if (left.occurredOn !== right.occurredOn || left.amountUsd !== right.amountUsd || left.category !== right.category || left.paymentMethod !== right.paymentMethod) return false;
  if (left.normalizedCustomerEmail || right.normalizedCustomerEmail) return Boolean(left.normalizedCustomerEmail && left.normalizedCustomerEmail === right.normalizedCustomerEmail);
  return Boolean(left.normalizedCustomerName && left.normalizedCustomerPhone && left.normalizedCustomerName === right.normalizedCustomerName && left.normalizedCustomerPhone === right.normalizedCustomerPhone);
}
```

Do not treat the existing looser `compareFinanceRows` result as exact proof. The SQL function is still the write-time authority.

- [ ] **Step 4: Verify the test passes and commit**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation.test.ts`, then commit `test(b2c): cover exact Finance duplicate rules`.

### Task 3: Build Admin-only grouping and review APIs

**Files:**

- Create: `src/server/repositories/b2c-exact-duplicate-reconciliation-repository.ts`
- Create: `src/server/services/b2c-exact-duplicate-review.ts`
- Create: `src/app/api/admin/b2c/reconciliation/exact-duplicates/route.ts`
- Create: `src/app/api/admin/b2c/reconciliation/exact-duplicates/group/route.ts`
- Create: `tests/b2c-exact-duplicate-reconciliation-api.test.ts`

**Interfaces:** `createExactDuplicateGroups(): Promise<{ createdGroups: number }>` invokes only the RPC. `listExactDuplicateGroups()` returns only pending groups with two Finance rows. The routes return `{ createdGroups }` and `{ groups }`.

- [ ] **Step 1: Write failing API tests**

```ts
expect((await groupRoute(request)).status).toBe(403);
expect(mockRpc).toHaveBeenCalledWith("create_b2c_exact_duplicate_groups", {});
expect(mockFrom).not.toHaveBeenCalledWith("b2c_payments");
expect(await (await listRoute(request)).json()).toEqual({ groups: [expectedGroup] });
```

Verify a list row includes only tab, row number, date, amount, direct name/e-mail/phone, category and payment method; no raw payload, storage path, provider payload, or financial total. Keep the existing decision API as the only write path for canonical/excluded choice.

- [ ] **Step 2: Verify the test fails**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation-api.test.ts`. Expect failure because the endpoints do not exist.

- [ ] **Step 3: Implement secured routes and model**

Both routes use `createServerSupabaseClient()` and `getApprovedRole()`, returning `403` before database access for any non-Admin. The repository calls the grouping RPC and reads only `exact_duplicate_candidate` groups through bounded group/link/Finance-row queries. The service returns:

```ts
type AdminExactDuplicateGroup = {
  groupId: string;
  state: "exact_duplicate_candidate";
  rows: Array<{ financeRowId: string; sourceTab: "B2C" | "B2C Cons"; sourceRowNumber: number; occurredOn: string; amountUsd: string; customerName: string | null; customerEmail: string | null; customerPhone: string | null; category: string; paymentMethod: string }>;
};
```

Reject a group that does not have exactly two rows rather than guessing. Do not create a Viewer source-row endpoint.

- [ ] **Step 4: Verify and commit**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation-api.test.ts`, then commit `feat(b2c): review exact Finance duplicate groups`.

### Task 4: Build the focused Admin decision UI

**Files:**

- Create: `src/features/b2c/b2c-exact-duplicate-review.tsx`
- Modify: `src/features/b2c/b2c-reconciliation-page.tsx`
- Create: `tests/b2c-exact-duplicate-reconciliation-ui.test.tsx`

**Interfaces:** `B2cExactDuplicateReview` accepts `onGroupsChanged(): Promise<void>` and owns only request/loading/form state.

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(await screen.findByRole("button", { name: "Find exact duplicates" })).toBeInTheDocument();
expect(screen.getByText("B2C row 12")).toBeInTheDocument();
expect(screen.getByText("B2C Cons row 33")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Confirm canonical Finance row" })).toBeDisabled();
```

Select a row and provide a reason; assert a `POST` to the existing decision route with `canonical`, the row ID, and reason. Exclusion sends a null canonical row. Assert a Viewer sees no contacts, Finance rows, grouping control, or decision controls; assert no total/published B2C revenue copy.

- [ ] **Step 2: Verify the test fails**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation-ui.test.tsx`. Expect failure because the component is absent.

- [ ] **Step 3: Implement the component**

Render it only for `useCanManage()` when Payment Tracker is complete. Load pending groups; **Find exact duplicates** calls the grouping route, reloads groups and safe coverage, and reports only the number created. Show both retained rows with tab/row labels. Require exactly one selected row plus a three-character reason before canonical confirmation; require a reason to exclude. Refresh/remove a group only after a successful response. Use safe error/loading states and place no financial rule in React.

- [ ] **Step 4: Verify and commit**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation-ui.test.tsx`, then commit `feat(b2c): decide exact Finance duplicate groups`.

### Task 5: Document and fully verify

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: this plan

- [ ] **Step 1: Update documentation and checkboxes**

Document the exact-key rule, ambiguity exclusion, Admin-only review, one-time decision, no automatic provider match, and continuing `Not fully loaded` gate.

- [ ] **Step 2: Run final verification**

Run the full test suite, typecheck, lint, build, diff check, and status check. Every application command must pass; state that `npm run supabase:test` remains retained but cannot run locally without the Supabase CLI.

- [ ] **Step 3: Commit documentation**

Commit `docs(b2c): document exact duplicate review` with the four operating docs and this plan.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 enforce and test exact unique pairing. Task 3 is the secured data boundary. Task 4 is the Admin experience. Task 5 keeps the no-publication boundary documented and verified.
- **Placeholder scan:** every validation and implementation step is concrete.
- **Type consistency:** Task 1 defines the only grouping RPC used in Task 3; Task 3 defines the exact group model consumed in Task 4; Task 4 uses the existing audited decision endpoint.
