# Stripe Charges CSV Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin preview, stage, and review a full Stripe Charges CSV as private B2C evidence without creating revenue or exposing sensitive payment data.

**Architecture:** Extend the existing B2C provider-evidence table with an immutable source-entry key and typed Admin-only contact fields. A pure CSV parser produces selected, non-sensitive source values plus a primary entry and, where directly supported, a linked refund entry. The authenticated upload service uses private Storage and one atomic RPC; a separate Admin-only read route returns a paginated safe review model.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Node.js `crypto`, `csv-parse`, Supabase Auth/Storage/PostgreSQL, Vitest, Testing Library.

## Global Constraints

- Accept only UTF-8 CSV files with BOM tolerated, at most 10 MiB and 20,000 non-blank data rows.
- Require normalized `id`, `Created date (UTC)`, `Amount`, `Amount Refunded`, `Currency`, `Captured`, `Fee`, `Mode`, and `Status` headers.
- Retain every non-blank source row as one primary Stripe evidence entry; create a second linked refund entry only for a positive direct refund on a captured Paid/Refunded charge with a charge ID.
- Preserve original currency and source values; never use Stripe `Converted Amount`/`Converted Currency` as USD values and never calculate a conversion or B2C total.
- Persist only selected non-sensitive source fields in PostgreSQL. Card, address, fingerprint, IP, payment-method, and metadata columns stay exclusively in the private original CSV.
- Use the existing `b2c-finance-imports` private bucket, Admin server-side authorization, SHA-256 confirmation, and storage cleanup if database finalization fails.
- No writes to `b2c_payments`, B2B, targets, reports, reconciliation groups, or Finance approvals. No Stripe API call, webhook change, or automatic matching.
- Admin review can show name, email, phone, source status, Stripe charge ID, entry type, and original currency/amount. Viewers and Executive users receive no individual contacts, identifiers, raw rows, amounts, or source files.
- A browser request must always leave its loading state after a response; an interrupted response is recoverable by refresh, and source hashes prevent a duplicate completed import.

---

### Task 1: Extend protected evidence provenance and add Stripe atomic finalization

**Files:**
- Create: `supabase/migrations/20260812102000_finalize_stripe_charges_import.sql`
- Modify: `src/types/database.generated.ts`, `supabase/tests/database_foundation.test.sql`, `docs/ARCHITECTURE.md`, `docs/INTEGRATIONS.md`, `docs/TESTING_STRATEGY.md`, `docs/PROJECT_STRUCTURE.md`

**Consumes:** Existing Admin-only RLS on `b2c_finance_imports` and `b2c_provider_evidence`; the private `b2c-finance-imports` bucket; source kind `stripe_charges`.

**Produces:**
```ts
finalize_stripe_charges_import(
  p_source_file_name: string,
  p_source_file_sha256: string,
  p_source_storage_bucket: string,
  p_source_storage_path: string,
  p_rows: StripeChargesEvidenceRowInput[],
): Promise<string>;
```

- [ ] **Step 1: Write the failing database assertion**

Add pgTAP assertions that `finalize_stripe_charges_import` exists, the evidence table has `source_entry_key`, `customer_name`, `customer_email`, and `customer_phone`, and no Stripe CSV finalizer writes to `b2c_payments`.

```sql
select has_function(
  'public', 'finalize_stripe_charges_import',
  array['text', 'text', 'text', 'text', 'jsonb'],
  'Stripe Charges finalizer exists'
);
select has_column('public', 'b2c_provider_evidence', 'source_entry_key', 'Stripe source entry key is retained');
select has_column('public', 'b2c_provider_evidence', 'customer_email', 'Stripe contact email is retained separately');
```

- [ ] **Step 2: Verify RED**

Run: `npm run supabase:test`

Expected: local command remains unavailable without the Supabase CLI; retain the pgTAP test for manual/CI database execution.

- [ ] **Step 3: Write the migration**

Create the migration with these exact database rules:

```sql
alter table public.b2c_provider_evidence
  add column source_entry_key text not null default 'primary'
    check (source_entry_key in ('primary', 'refund')),
  add column customer_name text
    check (customer_name is null or char_length(trim(customer_name)) between 1 and 200),
  add column customer_email citext
    check (customer_email is null or customer_email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  add column customer_phone text
    check (customer_phone is null or char_length(trim(customer_phone)) between 5 and 40);
```

Drop the existing `(import_id, source_row_number)` and `(provider, provider_row_id)` unique constraints, then add unique constraints on `(import_id, source_row_number, source_entry_key)` and `(provider, provider_row_id, source_entry_key)`. Replace the refund check so `refund` requires either a real provider refund ID or its linked provider payment ID; do not synthesize a refund ID.

Create `public.finalize_stripe_charges_import(...)` as `security definer`, `set search_path = public`, with authenticated-Admin authorization. It must validate source provenance, source hash, 1–20,000 JSON rows, `sourceEntryKey`, kind (`sale`, `refund`, or `needs_review`), ISO currency, non-negative six-decimal amounts, optional ISO UTC timestamp, direct contacts, and object raw payload. Charge ID is required for `sale` and `refund`, but an unknown row with no charge ID remains valid `needs_review` evidence. It inserts a `stripe_charges` import in `processing`, inserts all Stripe evidence entries, then transitions the import to `completed` in the same transaction. It must never insert `b2c_payments`.

For a refund entry, store `provider_payment_id = chargeId`, `provider_refund_id = null`, `source_entry_key = 'refund'`, and `debit_amount = amountRefunded`. For a primary sale, use `source_entry_key = 'primary'`, `provider_payment_id = chargeId`, and `credit_amount = amount`. Keep original Stripe status, captured flag, mode, description, fee, and source date in the non-sensitive raw payload.

Revoke public execution and grant the function only to `authenticated`.

- [ ] **Step 4: Update type snapshot and docs**

Add the new evidence columns and RPC signature to `src/types/database.generated.ts`. Update architecture, integrations, testing, and project-structure documentation to state that Stripe CSV evidence uses Admin-only typed contacts and source-entry keys, keeps sensitive source fields only in private Storage, and cannot create B2C revenue.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint`

```bash
git add supabase/migrations/20260812102000_finalize_stripe_charges_import.sql supabase/tests/database_foundation.test.sql src/types/database.generated.ts docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/TESTING_STRATEGY.md docs/PROJECT_STRUCTURE.md
git commit -m "feat(b2c): add atomic Stripe evidence staging"
```

### Task 2: Parse a minimized Stripe Charges CSV into source-entry evidence

**Files:**
- Modify: `src/lib/validation/b2c-finance-import-contracts.ts`, `src/server/services/b2c-finance-reconciliation.ts`
- Create: `src/server/services/stripe-charges-csv.ts`, `tests/stripe-charges-csv.test.ts`

**Consumes:** The new finalizer payload shape from Task 1 and installed `csv-parse`.

**Produces:**
```ts
export type StripeChargesEvidenceRow = {
  sourceRowNumber: number;
  sourceEntryKey: "primary" | "refund";
  chargeId: string | null;
  kind: "sale" | "refund" | "needs_review";
  occurredAt: string | null;
  occurredAtRaw: string | null;
  currency: string;
  credit: string | null;
  debit: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  rawPayload: Record<string, string>;
};
export function parseStripeChargesCsv(sourceFileName: string, bytes: Uint8Array): ParsedStripeCharges;
```

- [ ] **Step 1: Write failing parser tests**

Create a small CSV fixture with the required headers and assert:

```ts
expect(parsed.rows).toEqual(expect.arrayContaining([
  expect.objectContaining({ sourceEntryKey: "primary", kind: "sale", chargeId: "ch_paid", currency: "USD", customerEmail: "member@example.com" }),
  expect.objectContaining({ sourceEntryKey: "refund", kind: "refund", chargeId: "ch_refunded", debit: "50.42" }),
  expect.objectContaining({ sourceEntryKey: "primary", kind: "needs_review", chargeId: "ch_failed" }),
]));
expect(parsed.rows.every((row) => !("Card Last4" in row.rawPayload))).toBe(true);
```

Add separate tests that reject a missing required header, duplicate non-empty charge ID, malformed decimal, an invalid currency, a wrong extension, more than 20,000 data rows, and a refund amount on an uncaptured/failed source row. Assert non-USD rows preserve their original currency and never include a USD conversion field.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/stripe-charges-csv.test.ts`

Expected: FAIL because `parseStripeChargesCsv` does not exist.

- [ ] **Step 3: Define contracts and implement the pure parser**

Add strict Zod schemas for `sourceEntryKey`, direct contact values, non-negative decimals, source-row numbers, and the minimized raw payload. Implement:

```ts
const REQUIRED_HEADERS = [
  "id", "created date (utc)", "amount", "amount refunded", "currency",
  "captured", "fee", "mode", "status",
] as const;
```

Normalize headers by trimming, collapsing whitespace, stripping BOM, and lowercasing. Parse the explicit UTC source timestamp only in `YYYY-MM-DD HH:mm:ss` form into ISO UTC; retain any other value only as raw text. Keep the raw payload to the whitelist `id`, `created date (utc)`, `amount`, `amount refunded`, `currency`, `captured`, `fee`, `mode`, `status`, `description`, `paymentintent id`, `invoice id`, `invoice number`, `checkout line item summary`, and `refunded date (utc)`.

For each non-blank row, emit `primary`; emit `sale` only when the charge ID is non-empty, `Mode` is `Live`, `Captured` is `TRUE`, and `Status` is `Paid` or `Refunded`; otherwise emit `needs_review`. Emit `refund` only where that primary entry is `sale` and `Amount Refunded` is positive. Extract a contact name from `Card Name` then `Customer Description`, and e-mail/phone only from their direct customer columns. Do not make any provider request or calculate totals.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/stripe-charges-csv.test.ts && npm run typecheck && npm run lint`

```bash
git add src/lib/validation/b2c-finance-import-contracts.ts src/server/services/b2c-finance-reconciliation.ts src/server/services/stripe-charges-csv.ts tests/stripe-charges-csv.test.ts
git commit -m "feat(b2c): parse Stripe charges evidence"
```

### Task 3: Add secure Stripe preview and confirmed staging routes

**Files:**
- Create: `src/lib/validation/stripe-charges-upload-contracts.ts`, `src/server/services/stripe-charges-upload.ts`, `src/app/api/admin/b2c/stripe-charges/preview/route.ts`, `src/app/api/admin/b2c/stripe-charges/finalize/route.ts`
- Test: `tests/stripe-charges-upload-api.test.ts`

**Consumes:** `parseStripeChargesCsv`, `finalize_stripe_charges_import`, the private `b2c-finance-imports` bucket, and the request-scoped authenticated Supabase client.

**Produces:**
```ts
export type StripeChargesPreview = {
  sourceFileSha256: string;
  sourceRows: number;
  evidenceEntries: number;
  saleEntries: number;
  refundEntries: number;
  needsReviewEntries: number;
  rowsWithContact: number;
  nonUsdSaleEntries: number;
};
export async function previewStripeChargesUpload(file: File): Promise<StripeChargesPreview>;
export async function finalizeStripeChargesUpload(client: DatabaseClient, file: File, expectedFileSha256: string): Promise<string>;
```

- [ ] **Step 1: Write failing route/service tests**

Add tests following the Tap route boundary that prove:

```ts
expect(response.status).toBe(403); // Viewer, before parser invocation
expect(await response.json()).toEqual(expect.objectContaining({ preview: { sourceRows: 2, evidenceEntries: 3 } }));
expect(upload).not.toHaveBeenCalled(); // hash mismatch
expect(remove).toHaveBeenCalledWith([expect.stringMatching(/^stripe-charges\/[a-f0-9]{64}\/.+\.csv$/)]);
expect(client.rpc).toHaveBeenCalledWith("finalize_stripe_charges_import", expect.objectContaining({ p_rows: expect.any(Array) }));
```

Assert every preview response omits contacts, charge IDs, raw rows, and amount totals.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/stripe-charges-upload-api.test.ts`

Expected: FAIL because the Stripe CSV upload routes do not exist.

- [ ] **Step 3: Implement contracts, service, and thin routes**

Require exactly one `.csv` file and a 64-character preview hash. Re-parse and re-hash before confirmation. Store it under `stripe-charges/<sha256>/<uuid>.csv` in `b2c-finance-imports` with `text/csv`, call the atomic RPC with the parser entries, and remove that exact object if the RPC fails. Return only the import UUID on success.

Both routes must obtain the user through `createServerSupabaseClient()`, require `getApprovedRole(...) === "admin"` before reading multipart bytes, and return safe 403/422 JSON errors. The preview service must compute count-only values and never invoke Storage or the database.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/stripe-charges-upload-api.test.ts tests/stripe-charges-csv.test.ts && npm run typecheck && npm run lint`

```bash
git add src/lib/validation/stripe-charges-upload-contracts.ts src/server/services/stripe-charges-upload.ts src/app/api/admin/b2c/stripe-charges/preview/route.ts src/app/api/admin/b2c/stripe-charges/finalize/route.ts tests/stripe-charges-upload-api.test.ts
git commit -m "feat(b2c): add private Stripe charges upload"
```

### Task 4: Show Admin-only Stripe upload and contact review records

**Files:**
- Create: `src/server/repositories/stripe-charges-evidence-repository.ts`, `src/server/services/stripe-charges-evidence.ts`, `src/app/api/admin/b2c/stripe-charges/route.ts`
- Modify: `src/features/b2c/b2c-reconciliation-page.tsx`, `tests/b2c-finance-reconciliation-ui.test.tsx`, `docs/ARCHITECTURE.md`, `docs/INTEGRATIONS.md`, `docs/TESTING_STRATEGY.md`, `docs/PROJECT_STRUCTURE.md`
- Test: `tests/stripe-charges-evidence-api.test.ts`

**Consumes:** Completed `stripe_charges` imports and the typed provider-evidence columns from Task 1.

**Produces:**
```ts
export type AdminStripeEvidenceRecord = {
  evidenceId: string;
  sourceRowNumber: number;
  sourceEntryKey: "primary" | "refund";
  transactionKind: "sale" | "refund" | "needs_review";
  chargeId: string | null;
  occurredAt: string | null;
  occurredAtRaw: string | null;
  originalCurrency: string;
  originalAmount: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  sourceStatus: string | null;
};
```

- [ ] **Step 1: Write failing Admin-read and UI tests**

Create route tests that reject a Viewer and assert an Admin response maps typed fields only, excludes `raw_payload`, card/address data, and source-storage paths, and limits a request to 50 records.

Extend the reconciliation UI test with an Admin Stripe preview fixture and assert:

```ts
expect(await screen.findByLabelText("Stripe Charges CSV")).toBeInTheDocument();
expect(screen.getByText("Ada Founder")).toBeInTheDocument();
expect(screen.getByText("ada@example.com")).toBeInTheDocument();
expect(screen.getByText("+973 1700 0000")).toBeInTheDocument();
expect(screen.queryByText("4242")).not.toBeInTheDocument();
```

Assert a Viewer sees neither the Stripe upload controls nor the contact-review section.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/stripe-charges-evidence-api.test.ts tests/b2c-finance-reconciliation-ui.test.tsx`

Expected: FAIL because the Admin Stripe evidence read route and UI controls do not exist.

- [ ] **Step 3: Implement the Admin-only read boundary and UI**

Create a request-scoped repository that selects only completed `stripe_charges` evidence and the typed review fields, ordered by source-row number then source-entry key, limited to `1..50`. The service maps the raw rows to `AdminStripeEvidenceRecord`; it never returns `raw_payload`, storage paths, card/address/fingerprint/IP data, or any aggregate.

Create `GET /api/admin/b2c/stripe-charges?limit=50`, require Admin before repository access, validate `limit` with Zod, and return `{ records }` only.

In `B2cReconciliationPage`, add a separate Admin Stripe `.csv` field with **Preview Stripe Charges** and **Confirm Stripe staged import** buttons, independent loading/error/preview state, and a safe count preview. After confirmation, refresh coverage and fetch up to 50 Admin review records. Render a labelled, responsive review table with Name, Email, Phone, Status, Entry, Original amount/currency, and Charge ID. It has no total or conversion and shows a clear empty state before a completed import. Viewer rendering must contain none of this markup or data.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- tests/stripe-charges-evidence-api.test.ts tests/stripe-charges-upload-api.test.ts tests/stripe-charges-csv.test.ts tests/b2c-finance-reconciliation-ui.test.tsx
npm run typecheck
npm run lint
npm run build
```

```bash
git add src/server/repositories/stripe-charges-evidence-repository.ts src/server/services/stripe-charges-evidence.ts src/app/api/admin/b2c/stripe-charges/route.ts src/features/b2c/b2c-reconciliation-page.tsx tests/stripe-charges-evidence-api.test.ts tests/b2c-finance-reconciliation-ui.test.tsx docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/TESTING_STRATEGY.md docs/PROJECT_STRUCTURE.md
git commit -m "feat(b2c): review staged Stripe contacts"
```

## Final verification

- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` on the final tree.
- [ ] Run `npm run supabase:test` if the Supabase CLI becomes available; otherwise record that the retained pgTAP test is not runnable locally.
- [ ] Apply `supabase/migrations/20260812102000_finalize_stripe_charges_import.sql` manually in Supabase before testing the real Stripe CSV.
- [ ] Confirm with a real export that an Admin sees only the intended review fields, a Viewer sees none, and neither screen shows a B2C revenue total or currency conversion.
