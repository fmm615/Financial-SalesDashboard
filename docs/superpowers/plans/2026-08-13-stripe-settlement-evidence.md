# Stripe Settlement Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain and clearly display safe Stripe charge, settlement, conversion, refund, and payment-detail evidence without changing Stripe or allowing that evidence to alter B2C Finance reporting.

**Architecture:** Extend the Stripe normalisation boundary with typed evidence that is derived only from GET responses. Persist it in narrowly scoped one-to-one evidence tables, then expose a safe approved-user projection to the B2C dashboard. Keep original charge, Stripe settlement, refunds, and local PLAYBOOK reporting as separate labelled concepts.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Supabase PostgreSQL/RLS/RPC, Vitest, React Testing Library, Tailwind CSS.

## Global Constraints

- Stripe client requests must remain explicit HTTP `GET` requests only; never create, update, delete, or log provider data/secrets.
- Currency conversion/settlement evidence must never invent a USD rate or change B2C Finance totals.
- Refunds remain separate source entries linked to the original payment.
- Empty source fields remain unavailable, never zero or guessed.
- Viewer and Admin can see the selected safe operational evidence; raw provider payloads and sensitive card/address/payment-method identifiers remain inaccessible in the browser.
- Admin-only local corrections, mappings, and Finance-exception decisions remain server-authorised and audited.
- Every database change ships in a migration, and financial behaviour has focused tests.

---

### Task 1: Define and test typed Stripe evidence normalisation

**Files:**
- Modify: `tests/stripe-enrichment.test.ts`
- Modify: `src/lib/integrations/stripe/normalise.ts`
- Modify: `src/lib/integrations/stripe/enrichment.ts`

**Interfaces:**
- Produces `NormalisedStripeCharge` fields `description`, `sellerMessage`, `cardholderName`, `cardBrand`, and `cardLast4`.
- Produces `NormalisedStripeEnrichment` field `chargeEvidence` containing only safe typed payment evidence.
- Consumes Stripe Charge and Balance Transaction GET payloads.

- [ ] **Step 1: Write failing normalisation tests**

Add a Charge fixture with `description`, `outcome.seller_message`, and `payment_method_details.card` values. Assert that the normalised charge retains cleaned description/seller message/cardholder name/brand/last four digits, and assert that absent values remain `null`.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `npm test -- tests/stripe-enrichment.test.ts`

Expected: FAIL because the typed evidence fields do not exist yet.

- [ ] **Step 3: Implement the smallest typed, validated normalisation change**

Extend the Zod schema and `NormalisedStripeCharge` with bounded text fields. Do not persist or expose card IDs, fingerprints, address, CVC, payment method IDs, metadata, or raw payloads.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `npm test -- tests/stripe-enrichment.test.ts`

Expected: PASS.

### Task 2: Persist safe charge and refund settlement evidence

**Files:**
- Create: `supabase/migrations/20260813110000_stripe_safe_settlement_evidence.sql`
- Modify: `src/server/repositories/stripe-sync-repository.ts`
- Modify: `src/server/services/sync-stripe.ts`
- Modify: `tests/stripe-enrichment.test.ts`

**Interfaces:**
- Produces `persistStripeDetails(paymentId, enrichment)` with safe charge evidence.
- Produces `persistStripeRefundDetails(refundId, evidence)` when Stripe returns a refund balance transaction.
- Consumes `NormalisedStripeEnrichment` and a typed `NormalisedStripeRefund`.

- [ ] **Step 1: Write failing persistence/service tests**

Assert that a successful charge persists gross settlement, fee, fee tax, net payout, settlement currency, Stripe exchange rate, description, seller message, and masked card context. Assert that a refund settlement lookup is optional, is GET-only, and a failed lookup does not prevent retention of the refund source record.

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts`

Expected: FAIL because refund settlement evidence and safe charge evidence persistence are absent.

- [ ] **Step 3: Add the migration and provider orchestration**

Add nullable, constrained evidence columns to `b2c_stripe_payment_details` and a one-to-one `b2c_stripe_refund_details` table. Create only an approved-user safe SQL projection returning selected fields. Fetch a refund balance transaction only with `StripeClient.fetchBalanceTransaction`, retain it only if it validates, and record a safe optional-enrichment error on failure.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts`

Expected: PASS.

### Task 3: Add a safe dashboard evidence model and retrieval boundary

**Files:**
- Modify: `supabase/migrations/20260813110000_stripe_safe_settlement_evidence.sql`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`

**Interfaces:**
- Produces `B2cLedgerRow.stripeEvidence` with original charge evidence, settlement/conversion evidence, and linked refund evidence.
- Consumes `public.get_b2c_stripe_payment_evidence()` safe projection.

- [ ] **Step 1: Write failing dashboard model/presentation tests**

Use a B2C ledger row with safe Stripe evidence and assert it exposes the exact original amount/currency, settlement gross/fee/tax/net/currency/exchange-rate, refund totals, description, seller message, and masked-card values. Assert no field affects `isReportableB2cPayment` merely by being settlement evidence.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-payment-reportability.test.ts`

Expected: FAIL because `stripeEvidence` is not part of the dashboard model.

- [ ] **Step 3: Implement the safe dashboard repository mapping**

Call the SQL projection from the server repository, merge it by payment ID, and keep dashboard financial calculations on the existing effective/reportable B2C payment pathway. Do not select or return raw Stripe payloads.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-payment-reportability.test.ts`

Expected: PASS.

### Task 4: Present evidence without overloading the B2C ledger

**Files:**
- Create: `src/features/b2c/b2c-stripe-evidence-dialog.tsx`
- Modify: `src/features/b2c/b2c-operations.tsx`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`

**Interfaces:**
- Produces an accessible `View Stripe details` action for any Stripe ledger row with available evidence.
- Consumes `B2cLedgerRow.stripeEvidence`.

- [ ] **Step 1: Write a failing UI test**

Render a Stripe row with evidence, open `View Stripe details`, and assert grouped labels: `Original charge`, `Stripe settlement and conversion`, `Refunds`, and `Payment details`. Assert the explanatory copy says settlement conversion does not alter PLAYBOOK Finance reporting.

- [ ] **Step 2: Run the UI test to verify it fails**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: FAIL because there is no accessible details action or evidence dialog.

- [ ] **Step 3: Implement a compact, responsive evidence dialog**

Keep the ledger columns focused. Add one evidence action per Stripe record and show a grouped modal/dialog with values formatted as unavailable when null. Use semantic headings, labelled close control, no horizontal overflow, and short explanatory copy. Do not place editing actions in this Viewer-readable details dialog.

- [ ] **Step 4: Run the UI test to verify it passes**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: PASS.

### Task 5: Document boundaries and verify the whole change

**Files:**
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/superpowers/specs/2026-08-13-stripe-settlement-evidence-design.md`

- [ ] **Step 1: Document the exact evidence/reporting boundary**

Document the selected fields, the safe viewer projection, the raw-data exclusion, the read-only GET boundary, and the fact that settlement conversion evidence does not feed USD financial totals.

- [ ] **Step 2: Run focused tests, typecheck, lint, and production build**

Run:

```bash
npm test -- tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-payment-reportability.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: exit code 0 for each command.

- [ ] **Step 3: Review the working diff and prepare the handoff**

Run: `git diff --check && git diff --stat`

Summarise the data flow, financial rule, database migration, security boundary, test evidence, and any known Stripe limitation.

- [ ] **Step 4: Commit**

Use:

```bash
git add docs src supabase/migrations tests
git commit -m "feat(stripe): retain and show settlement evidence"
```
