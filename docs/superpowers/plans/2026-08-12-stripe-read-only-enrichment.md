# Stripe Read-Only Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich each existing Stripe B2C payment from readable Stripe objects so the dashboard receives the useful contact, product, fee, settlement, and tax context available to the Stripe export without modifying Stripe or creating duplicate sales.

**Architecture:** Keep the Charge as the single payment and exact Charge ID as the idempotency key. A read-only Stripe client retrieves optional referenced objects, focused normalizers distinguish transaction snapshots from mutable fallbacks, and a protected one-to-one local details table retains typed provenance. Only Charge, completed Checkout, and finalized Invoice contacts can fill transaction fields; Payment Method and Customer contacts are labelled display fallbacks and never affect reportability or duplicate fingerprints.

**Tech Stack:** Next.js 15, TypeScript 5.7, Zod 4, Supabase PostgreSQL/RLS, Vitest, React Testing Library

## Global Constraints

- Every Stripe HTTP request is `GET`; no create, update, refund, email, metadata, or delete method may exist.
- One Stripe Charge ID remains one `b2c_payments` row across webhooks, reconciliation, backfill, and CSV evidence.
- Missing values remain `NULL`, never zero or guessed.
- Charge gross sales, status, timestamp, and refund linkage remain authoritative.
- Settlement, fee, Stripe conversion, and tax values are evidence only and cannot alter B2C totals.
- Mutable Payment Method and Customer-profile contacts cannot satisfy reportability or change duplicate fingerprints.
- Existing local Admin corrections remain the highest-priority dashboard overlay.
- Never persist raw Stripe payloads, authorization headers, card data, addresses, fingerprints, IP addresses, or unrestricted metadata.
- The user manually applies every Supabase migration; stop after Task 1 and name the exact SQL file.
- Keep `tsconfig.tsbuildinfo` out of every commit.
- Rotate the previously displayed Stripe API key and webhook secret before any live Stripe verification.

---

### Task 1: Protected Stripe Enrichment Storage

**Files:**
- Create: `supabase/migrations/20260812105000_stripe_read_only_payment_enrichment.sql`
- Modify: `supabase/tests/database_foundation.test.sql`
- Modify: `tests/database-foundation.test.ts`
- Modify: `src/types/database.generated.ts`

**Interfaces:**
- Produces Admin-only table `public.b2c_stripe_payment_details`, keyed by
  `payment_id`, plus protected approved-viewer function
  `public.get_b2c_stripe_payment_contact_fallbacks()` containing no settlement
  data.
- Produces typed row `B2cStripePaymentDetailsRow` for Task 4 and typed safe-RPC
  return rows for Task 5.
- Allows approved users to read only the safe fallback function, permits no
  authenticated browser write policy, and relies on trusted service-role
  ingestion for table insert/update.

- [ ] **Step 1: Write failing migration contract tests**

Add a Vitest migration assertion that requires the table, the one-payment key,
typed contact columns, decimal settlement constraints, RLS, Admin-only table
read, a narrow approved-user contact function, and the absence of authenticated
write grants:

```ts
it("stores typed Stripe enrichment behind a read-only authenticated boundary", () => {
  const sql = migration("20260812105000_stripe_read_only_payment_enrichment.sql");
  expect(sql).toContain("create table public.b2c_stripe_payment_details");
  expect(sql).toContain("payment_id uuid primary key");
  expect(sql).toContain("references public.b2c_payments(id)");
  expect(sql).toContain("checkout_customer_email citext");
  expect(sql).toContain("customer_profile_email citext");
  expect(sql).toContain("settlement_fee_amount numeric(20,6)");
  expect(sql).toContain("enable row level security");
  expect(sql).toContain("create policy admin_read");
  expect(sql).toContain("create or replace function public.get_b2c_stripe_payment_contact_fallbacks()");
  expect(sql).toContain("public.is_approved_user()");
  expect(sql).not.toContain("grant insert, update on public.b2c_stripe_payment_details to authenticated");
});
```

Increase the pgTAP plan from 27 to 33 and add exactly six assertions:
`has_table`, contact `has_column`, settlement `has_column`, `has_function` for
the safe projection, an RLS `ok`, and `throws_ok` proving a linked Tap payment
cannot receive Stripe details.

- [ ] **Step 2: Run the migration contract tests and verify RED**

Run: `npm test -- tests/database-foundation.test.ts`

Expected: FAIL because `20260812105000_stripe_read_only_payment_enrichment.sql` does not exist.

- [ ] **Step 3: Create the migration**

Create a table with these exact column groups:

```sql
create table public.b2c_stripe_payment_details (
  payment_id uuid primary key references public.b2c_payments(id),
  payment_intent_id text,
  payment_method_id text,
  checkout_session_id text,
  invoice_id text,
  customer_id text,
  balance_transaction_id text,
  customer_name_source text,
  customer_email_source text,
  customer_phone_source text,
  charge_customer_name text,
  charge_customer_email citext,
  charge_customer_phone text,
  checkout_customer_name text,
  checkout_customer_email citext,
  checkout_customer_phone text,
  invoice_customer_name text,
  invoice_customer_email citext,
  invoice_customer_phone text,
  payment_method_customer_name text,
  payment_method_customer_email citext,
  payment_method_customer_phone text,
  customer_profile_name text,
  customer_profile_email citext,
  customer_profile_phone text,
  settlement_gross_amount numeric(20,6),
  settlement_fee_amount numeric(20,6),
  settlement_fee_tax_amount numeric(20,6),
  settlement_net_amount numeric(20,6),
  settlement_currency char(3),
  settlement_exchange_rate numeric(20,10),
  provider_tax_amount numeric(20,6),
  provider_tax_currency char(3),
  enrichment_status text not null,
  enrichment_issue_codes jsonb not null default '[]'::jsonb,
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Add checks for:

- source labels in `charge_receipt`, `charge_billing`, `charge_shipping`,
  `checkout_session`, or `invoice_snapshot`;
- `enrichment_status` in `complete` or `partial`;
- ISO uppercase currencies;
- non-negative gross, fee, fee-tax, and provider-tax values;
- positive exchange rates;
- text, email, phone, and provider-ID length limits;
- `settlement_net_amount = settlement_gross_amount - settlement_fee_amount`
  when all three are present; and
- `enrichment_issue_codes` being a JSON array.

Attach the existing `set_updated_at` trigger, enable RLS, grant only `SELECT` to
authenticated users, create only an `admin_read` table policy, revoke all
anonymous access, and do not create authenticated insert/update/delete policies
or grants. Add a database trigger that rejects a details row unless the linked
payment has `source_system = 'stripe'`.

Create a `security definer`, `set search_path = public` function returning only
`payment_id`, the first valid Payment Method/Customer-profile fallback for each
contact field, and its field-specific label. Reject callers for whom
`public.is_approved_user()` is false, revoke execution from `public`/`anon`,
grant execution only to `authenticated`, and expose no provider IDs,
settlement, tax, issue codes, or timestamps. Add the table and function to the
checked-in generated database snapshot.

- [ ] **Step 4: Run migration contract tests and verify GREEN**

Run: `npm test -- tests/database-foundation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit and push the storage foundation**

```bash
git add supabase/migrations/20260812105000_stripe_read_only_payment_enrichment.sql supabase/tests/database_foundation.test.sql tests/database-foundation.test.ts src/types/database.generated.ts
git commit -m "feat(stripe): add read-only enrichment storage"
git push origin main
```

Stop and tell the user to run exactly
`supabase/migrations/20260812105000_stripe_read_only_payment_enrichment.sql`
manually before Task 2 continues.

---

### Task 2: Stripe Object Validation and Evidence Precedence

**Files:**
- Create: `src/lib/integrations/stripe/enrichment.ts`
- Create: `tests/stripe-enrichment.test.ts`
- Modify: `src/lib/integrations/stripe/normalise.ts`
- Modify: `tests/stripe-integration.test.ts`

**Interfaces:**
- Produces `stripeChargeEnrichmentReferences(payload: unknown): StripeChargeEnrichmentReferences`.
- Produces `normaliseStripeEnrichment(input: StripeEnrichmentPayloads): NormalisedStripeEnrichment`.
- Produces `applyStripeTransactionEnrichment(charge: NormalisedStripeCharge, enrichment: NormalisedStripeEnrichment): NormalisedStripeCharge`.
- Produces `StripeContactSource`, `StripeContactEvidence`, `StripeSettlementEvidence`, and `NormalisedStripeEnrichment` types.

- [ ] **Step 1: Write failing normalizer tests**

Cover these known fixture behaviors:

```ts
expect(enrichment.transactionContact.email).toBe("checkout@example.com");
expect(enrichment.transactionContact.emailSource).toBe("checkout_session");
expect(enrichment.paymentMethodContact.email).toBe("mutable-pm@example.com");
expect(enrichment.customerProfileContact.email).toBe("current-profile@example.com");
expect(applyStripeTransactionEnrichment(chargeWithoutEmail, enrichment).customerEmail)
  .toBe("checkout@example.com");
```

Also prove that Charge contact wins over Checkout, Checkout wins over finalized
Invoice, incomplete Checkout and draft Invoice contacts are ignored, invalid
email/phone values become `null`, differing lower-priority values produce
conflict issue codes, and mutable fallback contacts never populate
`NormalisedStripeCharge.customerEmail`.

Use a Balance Transaction fixture with integer minor units and assert exact
decimal strings for AED gross, fee, fee tax, and net. Assert that an unsupported
or inconsistent settlement payload is rejected rather than rounded or repaired.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts`

Expected: FAIL because the enrichment module and reference fields do not exist.

- [ ] **Step 3: Implement strict focused schemas and precedence**

Keep schemas private and expose only normalized domain values. Extend the Charge
schema to accept direct string/object references for `payment_method`,
`balance_transaction`, `invoice`, `customer`, and `payment_intent`. Do not retain
expanded raw objects.

Implement exact contact selection:

```ts
const transactionSources = [chargeContact, completedCheckoutContact, finalizedInvoiceContact];
const name = firstValid(transactionSources, "name");
const email = firstValid(transactionSources, "email");
const phone = firstValid(transactionSources, "phone");
```

Normalize Payment Method and Customer contacts into separate fallback fields.
Normalize only one unambiguous Price/Product from Checkout first, then Invoice
when Checkout has none. Preserve Charge metadata product reference above both.
Represent all money as decimal strings derived from safe integer minor units;
never use JavaScript floating point for stored amounts.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit and push the validation layer**

```bash
git add src/lib/integrations/stripe/enrichment.ts src/lib/integrations/stripe/normalise.ts tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts
git commit -m "feat(stripe): validate payment enrichment evidence"
git push origin main
```

---

### Task 3: Explicit GET-Only Stripe Retrieval

**Files:**
- Modify: `src/lib/integrations/stripe/client.ts`
- Modify: `tests/stripe-enrichment.test.ts`

**Interfaces:**
- Produces `fetchCheckoutContextForPaymentIntent(paymentIntentId: string)`.
- Produces `fetchInvoice(invoiceId: string)`.
- Produces `fetchPaymentMethod(paymentMethodId: string)`.
- Produces `fetchCustomer(customerId: string)`.
- Produces `fetchBalanceTransaction(balanceTransactionId: string)`.
- Retains existing charge/refund list and retrieval interfaces.

- [ ] **Step 1: Write failing GET-only client tests**

Stub `global.fetch`, call every enrichment method, and assert:

```ts
expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
expect(requestedPaths).toEqual(expect.arrayContaining([
  "/v1/payment_methods/pm_123",
  "/v1/customers/cus_123",
  "/v1/invoices/in_123",
  "/v1/balance_transactions/txn_123",
]));
```

Also assert URL encoding, the Checkout lookup by exact PaymentIntent, bounded
line-item retrieval, safe provider errors, and that the class exposes no generic
public requester or Stripe write method.

- [ ] **Step 2: Run the client tests and verify RED**

Run: `npm test -- tests/stripe-enrichment.test.ts`

Expected: FAIL because the explicit retrieval methods do not exist.

- [ ] **Step 3: Implement the read methods**

Use the existing private `request(path)` method, which always sends
`{ method: "GET" }`. Retrieve only exact referenced IDs. Use query parameters
only for Stripe-supported read expansions needed for Invoice Price/Product and
Checkout line items. Return `null` for no Checkout Session and untrusted
`unknown` payloads for the normalizer.

- [ ] **Step 4: Run the client tests and verify GREEN**

Run: `npm test -- tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit and push the GET-only client**

```bash
git add src/lib/integrations/stripe/client.ts tests/stripe-enrichment.test.ts
git commit -m "feat(stripe): fetch enrichment objects read only"
git push origin main
```

---

### Task 4: Idempotent Enrichment Orchestration and Persistence

**Files:**
- Modify: `src/server/services/sync-stripe.ts`
- Modify: `src/server/repositories/stripe-sync-repository.ts`
- Modify: `tests/stripe-integration.test.ts`

**Interfaces:**
- Extends `StripeSource` with the five optional read methods from Task 3.
- Extends `persistCharge(...)` result to `{ paymentId: string; inserted: boolean }`.
- Produces repository method `persistStripeDetails(paymentId: string, details: NormalisedStripeEnrichment): Promise<void>` on `SupabaseStripeSyncRepository` only.
- Produces repository method
  `recordOptionalEnrichmentError(input: { integrationEventId?: string; syncRunId?: string; chargeId: string; objectType: "checkout_session" | "invoice" | "payment_method" | "customer" | "balance_transaction"; error: unknown }): Promise<void>`
  without failing or deleting a valid Charge.

- [ ] **Step 1: Write failing orchestration tests**

Test webhook, reconciliation, and historical backfill with fixtures that prove:

- referenced objects are read and normalized;
- the same Charge ID updates one local payment and one details row;
- Checkout/Invoice transaction contact can fill a missing Charge contact;
- Payment Method/Customer fallback never enters `persistCharge.customerEmail`;
- an existing non-empty transaction contact survives a partial lookup failure;
- a lower-priority conflicting contact opens `needs_follow_up`;
- optional failures persist the valid Charge, set details status `partial`, and
  record a safe Charge/object reference;
- existing local overrides are untouched; and
- settlement/fee/tax evidence is sent only to `persistStripeDetails`.

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `npm test -- tests/stripe-integration.test.ts tests/stripe-enrichment.test.ts`

Expected: FAIL because enrichment orchestration and details persistence are absent.

- [ ] **Step 3: Implement enrichment collection and safe persistence**

Add one focused `enrichCharge` orchestration function. Read only references that
exist, use `Promise.allSettled` for independent optional objects, normalize
successful payloads, and return safe issue codes for failed optional reads.

When updating `b2c_payments`, select the existing contact and source metadata.
Apply these merge rules independently to name/email/phone:

```text
incoming null                 -> retain existing
existing null                 -> accept incoming transaction evidence
same value                    -> retain value and most specific source
different, higher priority    -> accept incoming and flag conflict
different, equal/lower        -> retain existing and flag conflict
```

Recompute the content fingerprint only from the retained transaction email,
amount, approved category, business date, and Charge ID. Never use either
mutable fallback. Upsert the details table by `payment_id`, preserve known
values when an optional response is absent or failed, and write no raw object.

- [ ] **Step 4: Run orchestration tests and verify GREEN**

Run: `npm test -- tests/stripe-integration.test.ts tests/stripe-enrichment.test.ts tests/tap-integration.test.ts`

Expected: PASS, including Tap regression coverage for the shared repository.

- [ ] **Step 5: Commit and push orchestration**

```bash
git add src/server/services/sync-stripe.ts src/server/repositories/stripe-sync-repository.ts tests/stripe-integration.test.ts
git commit -m "feat(stripe): enrich payments without duplicate sales"
git push origin main
```

---

### Task 5: Labelled Dashboard Fallbacks and Reconciliation Evidence

**Files:**
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/features/b2c/b2c-operations.tsx`
- Create: `tests/b2c-stripe-enrichment-dashboard.test.tsx`

**Interfaces:**
- Extends `B2cLedgerRow` with `contactEvidenceLabel: "Stripe payment method" | "Stripe profile" | null`.
- Calls only `get_b2c_stripe_payment_contact_fallbacks`; settlement remains
  behind the Admin-only table and is not exposed by the general B2C snapshot.
- Leaves `resolveEffectiveB2cPayment` and reportability inputs based on transaction/local-correction fields only.

- [ ] **Step 1: Write failing dashboard tests**

Create a small known-value snapshot proving:

```ts
expect(screen.getByText("current-profile@example.com")).toBeInTheDocument();
expect(screen.getByText("Stripe profile")).toBeInTheDocument();
expect(snapshot.calculation.missingCustomerEmailCount).toBe(1);
expect(snapshot.eligiblePaymentsUsd).toBe("$0.00");
```

Also prove local correction beats every fallback, Payment Method beats Customer
only for display, fallback contacts are searchable, direct transaction contacts
have no fallback label, and fee/net evidence does not change gross, reportable,
refund, or net-payment totals.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: FAIL because the dashboard does not read the details table or label fallbacks.

- [ ] **Step 3: Implement repository and UI projection**

Read the safe fallback-contact RPC alongside existing payment data. For presentation:

```text
local correction -> transaction payment field -> Payment Method fallback -> Customer profile fallback -> null
```

Only the presentation projection uses fallback contacts. Continue passing the
original transaction/local-correction values to `isReportableB2cPayment` and
duplicate/review calculations. Render a small label under a fallback-only
contact. Keep settlement evidence out of this general snapshot and every
financial KPI; its Admin-only table remains available for the later provider
reconciliation workflow and never represents an additional sale.

- [ ] **Step 4: Run dashboard tests and verify GREEN**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-effective-payment.test.ts tests/stripe-integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit and push dashboard behavior**

```bash
git add src/server/repositories/b2c-dashboard-repository.ts src/features/b2c/b2c-operations.tsx tests/b2c-stripe-enrichment-dashboard.test.tsx
git commit -m "feat(b2c): show labelled Stripe contact fallbacks"
git push origin main
```

---

### Task 6: Documentation and Full Verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/STRIPE_SETUP.md`

**Interfaces:**
- Documents the read-only object graph, evidence precedence, fallback limits,
  migration, backfill behavior, and safe live comparison procedure.

- [ ] **Step 1: Update operational documentation**

Document:

- every Stripe object read and the fact that every call is `GET`;
- Charge/Checkout/finalized-Invoice transaction precedence;
- mutable Payment Method/Customer fallback labels and their inability to make a
  payment reportable;
- one Charge ID/one payment behavior;
- fees, settlement conversion, net, and tax as non-revenue evidence;
- historical backfill enrichment and partial-failure retry behavior;
- forbidden sensitive fields; and
- credential rotation before live verification.

- [ ] **Step 2: Run focused verification**

Run:

```bash
npm test -- tests/database-foundation.test.ts tests/stripe-enrichment.test.ts tests/stripe-integration.test.ts tests/tap-integration.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-effective-payment.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full completion verification**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all commands exit successfully. Run `npm run supabase:test` only if
the local Supabase CLI is installed and the new migration has been applied; if
the CLI is unavailable, report that limitation explicitly instead of claiming
the pgTAP suite passed.

- [ ] **Step 4: Inspect the final diff and security boundary**

Run:

```bash
git diff --check
git status --short
rg -n 'method: "(POST|PATCH|PUT|DELETE)"' src/lib/integrations/stripe
rg -n 'card_last4|fingerprint|ip_address|authorization' supabase/migrations/20260812105000_stripe_read_only_payment_enrichment.sql src/server/repositories/stripe-sync-repository.ts
```

Expected: no Stripe write method, no forbidden persisted field, no debug code,
and only intentional files plus the pre-existing generated
`tsconfig.tsbuildinfo` modification.

- [ ] **Step 5: Commit and push documentation**

```bash
git add docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/TESTING_STRATEGY.md docs/PROJECT_STRUCTURE.md docs/STRIPE_SETUP.md
git commit -m "docs(stripe): document read-only enrichment workflow"
git push origin main
```

- [ ] **Step 6: Perform a safe live comparison after credential rotation**

Use a dedicated local script or existing Admin backfill endpoint that imports
the application client and performs only its explicit read methods. Compare a
small sample by exact `ch_...` ID against the uploaded CSV. Report match/missing/
conflict counts without printing secrets, raw payloads, card data, addresses,
or customer contact values to terminal output. Do not proceed if the exposed
credentials have not been rotated.
