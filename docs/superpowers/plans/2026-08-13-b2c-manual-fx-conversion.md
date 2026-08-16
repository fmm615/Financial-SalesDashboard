# B2C Manual FX Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain foreign-currency Stripe and Tap B2C evidence, then allow only audited Admin FX conversions to create USD financial amounts.

**Architecture:** Provider normalisers preserve valid original-currency records with null USD provider values. A new append-only local FX conversion boundary calculates USD in PostgreSQL, resolves only the matching FX flag, and is consumed by the shared effective B2C reporting calculation. UI and Finance derive their amount from the same result.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Zod, Supabase PostgreSQL/RLS/RPC, Tailwind CSS.

## Global Constraints

- Stripe, Tap, and HubSpot are read-only sources; this feature makes no provider write request.
- Original provider amount/currency remain immutable and are never treated as USD without a locally recorded conversion.
- USD money uses `numeric(20,6)` and rates use `numeric(20,10)`; no floating-point financial arithmetic.
- Only authenticated Admins may create local FX conversions; every action is auditable and append-only.
- Source fees, VAT, transfers, balances, and non-sale evidence never become B2C sales.
- A payment/refund is included only after all existing reportability gates, including duplicate handling, pass.

---

### Task 1: Retain non-USD Tap source records

**Files:**
- Modify: `tests/tap-integration.test.ts`
- Modify: `src/lib/integrations/tap/normalise.ts`
- Modify: `docs/INTEGRATIONS.md`

**Interfaces:**
- Produces `normaliseTapCharge()` and `normaliseTapRefund()` results with original BHD amounts and `amountUsd: null`.
- Consumed by `runTapReconciliation()` and `runTapHistoricalBackfillBatch()`.

- [ ] Write a failing test for a captured BHD Tap charge that expects original BHD to be retained and USD fields to be null.
- [ ] Run `npm test -- --run tests/tap-integration.test.ts` and confirm the current USD-only normaliser fails it.
- [ ] Replace the USD-only guard with a currency normaliser that returns a provider USD rate/amount only for USD; retain other valid ISO currency codes with null USD fields.
- [ ] Document that non-USD Tap evidence is retained and requires the local FX conversion workflow.
- [ ] Run the focused Tap test and confirm it passes.

### Task 2: Add the append-only local B2C FX database boundary

**Files:**
- Create: `supabase/migrations/20260813190000_b2c_manual_fx_conversions.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `docs/BUSINESS_RULES.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATABASE_RULES.md`

**Interfaces:**
- Produces `b2c_payment_fx_conversions`, `b2c_refund_fx_conversions`, and protected `record_b2c_*_fx_conversion` RPCs.
- The payment RPC accepts `(payment_id, exchange_rate_to_usd, conversion_source, effective_on, reason)` and returns the calculated USD amount.
- The refund RPC has the equivalent fields and resolves only refund FX flags.

- [ ] Add SQL assertions/test coverage for a non-USD record using no provider USD rate, a valid positive local rate, and a calculated six-decimal USD result.
- [ ] Run the test/SQL check and confirm it fails before the migration exists.
- [ ] Create append-only conversion tables with source amount/currency snapshots, actor, rate, source, effective date, reason, and calculated USD amount.
- [ ] Add Admin-only RLS and security-definer RPCs that lock the source row, validate inputs, calculate USD in PostgreSQL, insert a financial correction, and resolve only `needs_fx_review`.
- [ ] Update the Finance-exception RPC so it accepts an effective local FX conversion but still rejects foreign records with no conversion.
- [ ] Update generated types and the three docs to define the approved local-FX rule.
- [ ] Run migration SQL lint/type checks and focused test coverage.

### Task 3: Make the shared B2C effective calculation use approved FX

**Files:**
- Modify: `tests/b2c-payment-reportability.test.ts`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- Modify: `src/lib/b2c/effective-payment.ts`
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/server/repositories/stripe-sync-repository.ts` if conversion-state flag copy must change

**Interfaces:**
- Extends effective B2C rows with `fxConversionAmountUsd`, rate/source/date, and `hasLocalFxConversion`.
- `isReportableB2cPayment()` treats foreign currency as reportable only when it has a valid effective USD amount.

- [ ] Add failing unit tests showing that a BHD payment remains excluded without an FX conversion, becomes eligible with an audited conversion and other valid fields, and remains excluded when duplicate/failed/unmapped conditions exist.
- [ ] Run the focused tests and confirm their current foreign-currency behavior fails.
- [ ] Add conversion projections to the repository and resolve the latest conversion for each payment/refund.
- [ ] Make the effective calculation choose a local FX result for a foreign source before reportability and totals use the amount.
- [ ] Ensure refunds are calculated separately from payments and cannot exceed the effective converted payment amount where both conversions exist.
- [ ] Run focused tests and ensure old USD behavior is unchanged.

### Task 4: Add an Admin-only local FX conversion interaction

**Files:**
- Create: `src/app/api/admin/b2c/payments/[paymentId]/fx-conversion/route.ts`
- Create: `src/app/api/admin/b2c/refunds/[refundId]/fx-conversion/route.ts`
- Modify: `src/lib/validation/b2c.ts`
- Modify: `src/features/b2c/b2c-payment-review-actions.tsx`
- Modify: `src/features/b2c/b2c-operations.tsx`
- Test: `tests/b2c-payment-review-actions.test.tsx`

**Interfaces:**
- Routes validate rate, source, effective date, and reason with Zod and invoke only the protected local RPCs.
- UI submits one local conversion, displays a calculated USD preview, and never offers a provider write.

- [ ] Add failing component/API tests for the BHD conversion form, calculated preview, disabled save for invalid input, and Admin-only action state.
- [ ] Run the targeted tests and confirm they fail because the FX action does not exist.
- [ ] Add typed request contracts and thin authenticated routes.
- [ ] Add a compact editor section that shows source BHD amount, accepts rate/source/date/reason, previews USD, and saves locally.
- [ ] Show “Needs FX review” until saved, then show the local conversion information while retaining other open flags.
- [ ] Run tests and inspect the dialog in the browser at desktop and narrow widths.

### Task 5: Verify financial consistency and provider read-only behavior

**Files:**
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Test: `tests/tap-integration.test.ts`
- Test: `tests/b2c-payment-reportability.test.ts`

- [ ] Add regression tests confirming Tap calls only GET/list endpoints and conversion flows never construct a provider request.
- [ ] Add regression tests showing fee/VAT/transfer/balance evidence cannot enter a B2C financial total.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test -- --run tests/tap-integration.test.ts tests/b2c-payment-reportability.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-payment-review-actions.test.tsx`.
- [ ] Run `npm run build`.
- [ ] Review the migration steps for Supabase SQL Editor and provide the exact migration filename for manual application.

## Coverage Review

- Retaining BHD Tap source records: Task 1.
- Append-only admin conversion/audit/RLS: Task 2.
- Shared dashboard and Finance calculation: Task 3.
- Safe Admin UI and server validation: Task 4.
- Provider read-only, source classification, typecheck/lint/tests/build: Task 5.
