# Stripe Foreign-Currency Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain every valid Stripe charge and succeeded refund as local source evidence, including non-USD currency, while hard-blocking records without an approved USD conversion from Finance totals and making them easy for an Admin to review.

**Architecture:** Stripe normalisation will retain the provider’s original amount and ISO currency for every valid record. Only native USD source records receive a USD amount; foreign-currency records have a `NULL` USD amount and exchange rate, are represented as `Needs FX review`, and remain non-reportable even when a local correction or Finance exception exists. The B2C ledger receives a one-click `Show foreign-currency review` filter so Finance can inspect those records without a second workflow.

**Tech Stack:** Next.js 15, React 19, TypeScript, Supabase/Postgres migrations and RLS-backed RPCs, Vitest, Tailwind.

## Global Constraints

- Stripe is read-only: no code in this feature may send Stripe a POST, PATCH, PUT, or DELETE request.
- Source evidence is never silently converted or guessed; a missing USD conversion is not zero.
- Original provider amount, currency, provider ID, and source date remain traceable in PLAYBOOK.
- All reportable B2C totals remain USD-only and require an actual USD amount.
- An Admin may save local PLAYBOOK corrections and audit evidence, but that must not create a USD conversion for a foreign-currency provider record.
- Viewer access remains read-only; all persistence continues through authenticated Admin-only server/RPC boundaries.
- Existing user work in `src/features/b2c/b2c-operations.tsx` and `tests/b2c-stripe-enrichment-dashboard.test.tsx` must be preserved.
- Every database behavior change has a new migration; generated types are refreshed only after the migration is applied locally.

---

## File Structure

- `src/lib/integrations/stripe/normalise.ts` — turns valid Stripe amounts into source facts without rejecting a non-USD currency.
- `src/lib/b2c/payment-reportability.ts` — central USD-reportability gate shared by B2C dashboard calculations.
- `src/lib/b2c/duplicate-fingerprint.ts` — includes source currency in a content fingerprint so identical numerical values in different currencies are not falsely compared.
- `src/server/repositories/stripe-sync-repository.ts` — persists source-only foreign-currency records and opens their local review flag.
- `src/server/repositories/b2c-dashboard-repository.ts` — returns safe source amount/currency, review status, and USD-safe aggregates to the UI.
- `src/features/b2c/b2c-operations.tsx` — displays the one-click foreign-currency ledger filter and clearly labels source amount versus unavailable USD reporting value.
- `supabase/migrations/20260813120000_retain_stripe_foreign_currency_source_records.sql` — allows unknown USD fields only for non-USD source facts and blocks Finance exceptions for them at database level.
- `tests/stripe-integration.test.ts` — normalisation and read-only ingestion coverage.
- `tests/b2c-payment-reportability.test.ts` — reportability coverage for foreign currency.
- `tests/b2c-stripe-enrichment-dashboard.test.tsx` — B2C ledger control/UI coverage.
- `docs/INTEGRATIONS.md` and `docs/ARCHITECTURE.md` — provider and reporting behavior documentation.

### Task 1: Retain foreign-currency Stripe source facts

**Files:**
- Modify: `tests/stripe-integration.test.ts`
- Modify: `src/lib/integrations/stripe/normalise.ts`
- Modify: `src/lib/b2c/duplicate-fingerprint.ts`

**Interfaces:**
- Produces: `NormalisedStripeCharge.amountUsd: string | null` and `exchangeRateToUsd: "1" | null`.
- Produces: `NormalisedStripeRefund.amountUsd: string | null` and `exchangeRateToUsd: "1" | null`.
- Produces: `createB2cDuplicateFingerprint({ customerEmail, amountUsd, originalCurrency, categoryCode, occurredOn, providerTransactionId })`.

- [ ] **Step 1: Write the failing normalisation test**

```ts
it("retains a non-USD Stripe charge as source evidence without inventing USD", () => {
  const payment = normaliseStripeCharge({ ...charge, currency: "bhd" }, "product_id");
  expect(payment).toMatchObject({
    originalAmount: "123.45",
    originalCurrency: "BHD",
    exchangeRateToUsd: null,
    amountUsd: null,
  });
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npm test -- tests/stripe-integration.test.ts`

Expected: FAIL because `normaliseStripeCharge` currently rejects a BHD charge as unsupported.

- [ ] **Step 3: Implement only source retention**

```ts
function usdReportingValues(originalAmount: string, originalCurrency: string) {
  return originalCurrency === "USD"
    ? { exchangeRateToUsd: "1" as const, amountUsd: originalAmount }
    : { exchangeRateToUsd: null, amountUsd: null };
}
```

Use this helper for charge and succeeded-refund normalisation. Keep `originalAmount` and uppercase `originalCurrency` unchanged. Add `originalCurrency` to the duplicate-fingerprint input and hash payload so `50.42 USD` and `50.42 BHD` cannot become candidates for each other.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `npm test -- tests/stripe-integration.test.ts`

Expected: PASS; the existing USD and failed/pending-refund tests remain green.

- [ ] **Step 5: Commit the isolated unit of work**

```bash
git add tests/stripe-integration.test.ts src/lib/integrations/stripe/normalise.ts src/lib/b2c/duplicate-fingerprint.ts
git commit -m "feat(stripe): retain foreign-currency source evidence"
```

### Task 2: Enforce the USD financial boundary in code and database

**Files:**
- Modify: `tests/b2c-payment-reportability.test.ts`
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `src/server/repositories/stripe-sync-repository.ts`
- Create: `supabase/migrations/20260813120000_retain_stripe_foreign_currency_source_records.sql`

**Interfaces:**
- Consumes: nullable USD values from Task 1.
- Produces: exclusion reason `needs_fx_review` for a non-USD source record or missing USD reporting value.
- Produces: database constraints that accept `NULL` USD values only when `original_currency <> 'USD'`.

- [ ] **Step 1: Write the failing reportability test**

```ts
it("never reports a foreign-currency source payment without an approved USD value", () => {
  const input = {
    ...completePayment,
    originalCurrency: "BHD",
    amountUsd: null,
    hasFinanceException: true,
  };
  expect(b2cPaymentExclusionReasons(input)).toContain("needs_fx_review");
  expect(isReportableB2cPayment(input)).toBe(false);
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npm test -- tests/b2c-payment-reportability.test.ts`

Expected: FAIL because the current gate permits an approved exception without checking source currency.

- [ ] **Step 3: Implement the central code gate**

Extend `B2cPaymentReportabilityInput` with `originalCurrency` and `amountUsd`. Push `needs_fx_review` before checking a Finance exception when `originalCurrency !== "USD"` or `amountUsd === null`. Update every dashboard caller to pass the source payment currency and source USD value—not a local override—as the conversion fact.

Update the provider repository types to accept nullable USD values. Persist the original source amount/currency, `NULL` USD fields, and one open local `needs_follow_up` flag describing the required Finance-approved FX source. Retain provider-ID deduplication and do not create an integration error merely because currency is non-USD.

- [ ] **Step 4: Add the migration**

The migration must:

```sql
alter table public.b2c_payments
  alter column exchange_rate_to_usd drop not null,
  alter column amount_usd drop not null,
  alter column gross_amount_usd drop not null;

alter table public.b2c_refunds
  alter column exchange_rate_to_usd drop not null,
  alter column amount_usd drop not null;
```

Add check constraints that require `USD` rows to have exchange rate `1` and positive USD values, and require non-USD rows to have `NULL` USD conversion fields. Change `prevent_refund_overage` to return without a USD comparison when either linked source amount is unavailable. Replace/extend `apply_b2c_finance_exception` so it raises an exception for a source payment whose `original_currency <> 'USD'` or `amount_usd is null`.

- [ ] **Step 5: Run the code tests and inspect migration syntax**

Run: `npm test -- tests/b2c-payment-reportability.test.ts tests/stripe-integration.test.ts`

Expected: PASS. Then run `npm run typecheck`; expected: PASS after all nullable types are handled.

- [ ] **Step 6: Commit the safety boundary**

```bash
git add tests/b2c-payment-reportability.test.ts src/lib/b2c/payment-reportability.ts src/server/repositories/stripe-sync-repository.ts supabase/migrations/20260813120000_retain_stripe_foreign_currency_source_records.sql
git commit -m "feat(b2c): block unconverted foreign currency from finance"
```

### Task 3: Add the B2C foreign-currency review control

**Files:**
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/features/b2c/b2c-operations.tsx`

**Interfaces:**
- Consumes: B2C ledger rows with `originalAmount`, `originalCurrency`, `amountUsd: null`, and an `isForeignCurrency` boolean.
- Produces: `Show foreign-currency review (N)` and `Show all ledger records` controls.

- [ ] **Step 1: Write the failing UI test**

```tsx
it("filters the B2C ledger to foreign-currency source records", async () => {
  render(<B2cOperations snapshot={snapshotWithUsdAndBhdRows} canManage />);
  await userEvent.click(screen.getByRole("button", { name: /show foreign-currency review/i }));
  expect(screen.getByText("BHD 50.42")).toBeInTheDocument();
  expect(screen.queryByText("USD 50.42")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: FAIL because the filter button and foreign-currency row representation do not exist yet.

- [ ] **Step 3: Implement the dashboard projection and UI**

Add original source amount/currency and `isForeignCurrency` to the ledger row. Format a foreign source amount as `BHD 50.42`; show `USD conversion unavailable` in the USD amount context. Keep the existing wide table inside its horizontal-scroll wrapper. Add one non-destructive client-side filter button near the existing ledger filters with an accessible `aria-pressed` state and a clear return-to-all button. The issue cell must show `Needs FX review` in addition to any existing source issue.

- [ ] **Step 4: Run dashboard tests and verify GREEN**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: PASS. Also run `npm run typecheck`; expected: PASS with no `trim`/number type errors.

- [ ] **Step 5: Commit the review experience**

```bash
git add tests/b2c-stripe-enrichment-dashboard.test.tsx src/server/repositories/b2c-dashboard-repository.ts src/features/b2c/b2c-operations.tsx
git commit -m "feat(b2c): add foreign-currency review filter"
```

### Task 4: Document and verify the end-to-end behavior

**Files:**
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Documents: raw Stripe source retention, no provider mutation, USD-only Finance calculation, and the Admin review boundary.

- [ ] **Step 1: Update provider documentation**

Document that valid Stripe non-USD charge/refund source facts are retained with `original_amount` and `original_currency`, do not become integration failures, and are not converted or included in USD totals without a Finance-approved FX source/rule.

- [ ] **Step 2: Update architecture documentation**

Document the separation between source evidence, local review flags, local Admin corrections, and USD financial reporting. State that neither a correction nor Finance exception can fabricate a conversion.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test -- tests/stripe-integration.test.ts tests/b2c-payment-reportability.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx
npm run typecheck
npm run lint
```

Expected: every command exits `0`.

- [ ] **Step 4: Commit docs and present the database migration**

```bash
git add docs/INTEGRATIONS.md docs/ARCHITECTURE.md docs/superpowers/plans/2026-08-13-stripe-foreign-currency-review.md
git commit -m "docs: explain Stripe foreign-currency review boundary"
```

Tell the user to apply `20260813120000_retain_stripe_foreign_currency_source_records.sql` in Supabase SQL Editor before retrying the affected Stripe source records.

## Self-Review

- Spec coverage: Task 1 retains exact source facts; Task 2 prevents conversion guessing and Finance inclusion; Task 3 exposes a single accessible review control; Task 4 documents and verifies the boundaries. Stripe is never mutated in any task.
- Placeholder scan: no pending implementation placeholders, generic test instructions, or unexplained behavior are present.
- Type consistency: `originalCurrency`, nullable `amountUsd`, nullable `exchangeRateToUsd`, and `needs_fx_review` are defined before the repository and UI consume them.
