# B2C Cross-Tab Duplicate Rule Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the evidenced 63 `B2C`/`B2C Cons` same-name/date/amount/payment-method pairs reviewable without automatically publishing any B2C revenue.

**Architecture:** A follow-up migration replaces only the protected grouping function. It removes category, e-mail, and phone from the cross-tab comparison because the real Finance tabs do not share those equivalent fields. The existing unique pair key, same-import requirement, exact-once-per-tab ambiguity guard, Admin-only database boundary, and canonical/excluded decision process remain unchanged.

**Tech Stack:** TypeScript, Vitest, Supabase PostgreSQL/RLS, Next.js.

## Global Constraints

- Match only valid rows from one completed Payment Tracker import: one `B2C` and one `B2C Cons` row with equal normalized name, date, USD amount, and payment method.
- A key occurring more than once in either tab is ambiguous and creates no group.
- No action writes `b2c_payments`, totals, targets, reports, Finance period approval, or provider data.
- Grouping remains Admin-only; canonical/excluded decisions remain append-only and require a reason.
- User applies the migration manually in Supabase; local pgTAP remains unavailable without the Supabase CLI.

### Task 1: Change the database and pure grouping rule

**Files:**

- Create: `supabase/migrations/20260812104000_adjust_b2c_cross_tab_duplicate_grouping.sql`
- Modify: `src/server/services/b2c-exact-duplicate-reconciliation.ts`
- Modify: `tests/b2c-exact-duplicate-reconciliation.test.ts`
- Modify: `tests/database-foundation.test.ts`

**Interfaces:** Existing `create_b2c_exact_duplicate_groups()` continues returning the number of newly created groups. `isExactFinanceCrossTabPair()` accepts identical name/date/amount/payment method even when contact/category fields differ.

- [x] **Step 1: Write failing tests**

```ts
expect(isExactFinanceCrossTabPair(b2cRow, {
  ...b2cConsRow,
  normalizedCustomerEmail: null,
  normalizedCustomerPhone: null,
  category: "b2c-membership",
})).toBe(true);
expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, paymentMethod: "bank transfer" })).toBe(false);
expect(isUnambiguousExactFinanceKey([b2cRow, b2cConsRow, anotherB2c])).toBe(false);
```

Add a migration-contract assertion that the adjustment creates the function with `normalized_customer_name`, has both exact-once `count(*) filter` conditions, and does not mention `category_key`, `customer_email_key`, or `b2c_payments`.

- [x] **Step 2: Verify failure**

Run `npm test -- tests/b2c-exact-duplicate-reconciliation.test.ts tests/database-foundation.test.ts`.

Expected: the existing phone/e-mail/category rule rejects the revised pair and the adjustment migration is absent.

- [x] **Step 3: Implement the minimal adjustment**

The new migration uses `create or replace function public.create_b2c_exact_duplicate_groups()` with the existing Admin check, advisory transaction lock, provider-evidence exclusion, group key, and conflict-safe inserts. Its comparison rows group only this identity key:

```sql
rows.normalized_customer_name as customer_name_key
```

The exact-pair CTE groups by `import_id`, `occurred_on`, `amount_usd`, `payment_method_key`, and `customer_name_key`; it requires `count(*) filter (where source_tab = 'B2C') = 1`, `count(*) filter (where source_tab = 'B2C Cons') = 1`, and `count(*) = 2`.

Update the pure TypeScript rule to require the same import, valid quality, distinct approved tabs, non-null equal name/date/amount/payment method. It must ignore e-mail, phone, and category for this cross-tab comparison.

- [x] **Step 4: Verify and commit**

Run focused tests, `npm run typecheck`, and `git diff --check`, then commit `fix(b2c): align cross-tab duplicate grouping`.

### Task 2: Document the operating rule and fully verify

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: this plan

- [x] **Step 1: Document the source-backed rule**

Replace prior wording that requires category/direct-identity equality with the approved name/date/USD amount/payment-method exact key. Document that e-mail/category are structurally incompatible across these tabs and still remain visible only to Admin reviewers.

- [x] **Step 2: Verify all affected behavior**

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`, and `git status --short`. Report that `npm run supabase:test` remains blocked by the unavailable local CLI.

- [x] **Step 3: Commit**

Commit `docs(b2c): document cross-tab grouping adjustment` with the operating docs and completed plan checkboxes.

## Plan Self-Review

- **Spec coverage:** Task 1 applies and tests the only changed key; Task 2 documents the evidence-backed distinction and verifies no financial publishing boundary changes.
- **Placeholder scan:** every changed file, exact comparison key, validation command, and commit is specified.
- **Type consistency:** the existing grouping RPC and Admin UI contract remain unchanged; only their source candidate selection changes.
