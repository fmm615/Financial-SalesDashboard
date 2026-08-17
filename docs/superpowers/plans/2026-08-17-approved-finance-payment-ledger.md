# Approved Finance Payment Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add valid, already approved iOS and bank-transfer Payment Tracker rows to the B2C ledger exactly once, with immutable Finance provenance and no provider writes.

**Architecture:** A protected PostgreSQL function selects only eligible staged Finance rows and writes one `finance_tracker` B2C payment plus one immutable provenance link in one transaction. An Admin-only API and posting control call that function. The B2C dashboard reads the link so the existing reportability gate permits this specific approved-Finance source, even when its e-mail is absent.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, Supabase PostgreSQL/RLS, PostgreSQL audit triggers.

## Global Constraints

- Post only `row_quality = 'valid'`, positive, dated Payment Tracker rows whose normalized method is exactly `ios` or `bank transfer`.
- Finance already approved these entries. The one posting action is not a second per-row approval flow.
- Only a canonical row in an exact B2C/B2C Cons duplicate group can post. Excluded, unresolved, possible, or conflict group rows do not post.
- Use tracker amount as USD gross revenue excluding VAT. Infer no VAT, fee, provider ID, exchange rate, time of day, or contact value.
- Missing contacts stay missing. The missing-e-mail exception applies only to a linked approved Finance-ledger payment.
- Do not write to Stripe, Tap, Apple, B2B, reports, targets, or the staged workbook data.
- All writes are Admin-only, transactional, append-only/audited, idempotent, and safe to retry.
- The user applies the new migration manually in Supabase. Do not commit `tsconfig.tsbuildinfo`.

## File Structure

- `supabase/migrations/20260817100000_post_approved_b2c_finance_payments.sql`: source constraint, ledger-post provenance, RLS/audit, and protected RPC.
- `src/types/database.generated.ts`: `finance_tracker`, post table, and RPC result contract.
- `src/lib/b2c/approved-finance-payment.ts`: pure method/category/result mapping.
- `src/lib/b2c/payment-reportability.ts`: narrow approved-Finance provenance input.
- `src/server/repositories/b2c-finance-ledger-repository.ts`: one protected-RPC caller.
- `src/app/api/admin/b2c/finance-ledger-posts/route.ts`: Admin-only POST route.
- `src/features/b2c/b2c-approved-finance-posting.tsx`: Admin posting control and safe count result.
- `src/features/b2c/b2c-reconciliation-page.tsx`: page composition.
- `src/server/repositories/b2c-dashboard-repository.ts`: provenance-aware reportability and Finance source labels.
- `tests/approved-finance-payment*.test.ts*`, `tests/b2c-dashboard-repository.test.ts`, and `tests/database-foundation.test.ts`: behavioral coverage.

### Task 1: Persist Finance payments and immutable provenance

**Files:**

- Create: `supabase/migrations/20260817100000_post_approved_b2c_finance_payments.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `tests/database-foundation.test.ts`
- Modify: `supabase/tests/database_foundation.test.sql`

**Interfaces:** `post_approved_b2c_finance_payments()` returns `{ posted_payments integer, already_posted_payments integer, skipped_rows integer }`.

- [x] **Step 1: Write failing tests**

Assert the migration contains `finance_tracker`, `create table public.b2c_finance_ledger_posts`, unique `finance_row_id` and `payment_id`, the protected RPC, its Admin error message, and no provider URL/call. Add pgTAP cases rejecting non-Admin callers, posting the same Finance row twice, and posting a noncanonical duplicate member.

- [x] **Step 2: Verify RED**

Run `npm test -- tests/database-foundation.test.ts`. It must fail because the migration is absent.

- [x] **Step 3: Add the migration**

Replace the B2C source-system checks so `finance_tracker` is allowed without weakening the existing Stripe/Tap/manual-bank-transfer rules. Create `b2c_finance_ledger_posts(finance_row_id unique, payment_id unique, finance_payment_method check ('bank_transfer','ios'), source_amount_basis check ('gross_excluding_vat'), posted_by, posted_at)`; enable RLS, attach `write_audit_event`, and keep direct writes Admin-only.

Create the security-definer RPC. Verify `auth.uid()` and `is_admin()`. Lock and select completed Payment Tracker rows only. Require valid quality, positive USD amount, date, category that deterministically converts to a lower-case hyphenated code, and normalized method `ios` or `bank transfer`. Skip rows already in the provenance table. For any grouped source row, select only when its group state is `canonical` and the row is its canonical Finance row.

For each selection, insert one succeeded `b2c_payments` row using source `finance_tracker`, no provider ID, USD amount/original/gross amount equal to the staged value, rate 1, tax/net null, and UTC midnight for the date-only source. Copy source name/email/phone. Store import ID, tab, row number, raw payment method, raw category, membership type, and `source_amount_basis: gross_excluding_vat` in source metadata. Hash only the Finance row ID for the duplicate fingerprint. Insert its provenance row and return authoritative posted/already/skipped counts. Revoke public execute and grant authenticated execute.

- [x] **Step 4: Verify GREEN**

Update the checked-in type snapshot and run `npm test -- tests/database-foundation.test.ts`. It must pass.

- [x] **Step 5: Commit**

Commit only the migration, generated type contract, and database tests with `feat(b2c): add approved Finance ledger posting`.

### Task 2: Define the pure business rules

**Files:**

- Create: `src/lib/b2c/approved-finance-payment.ts`
- Create: `tests/approved-finance-payment.test.ts`
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `tests/b2c-payment-reportability.test.ts`

**Interfaces:** `normalizeApprovedFinancePaymentMethod(value)`, `normalizeFinanceCategoryCode(value)`, and `mapApprovedFinancePostResult(value)`.

- [x] **Step 1: Write failing tests**

Test `Bank transfer` maps to `bank_transfer`, `iOS` maps to `ios`, and `Stripe` is rejected. Test `B2C- Membership` maps to `b2c-membership`, blank category is rejected, and RPC snake-case counts map to typed camel-case counts. Test that a missing e-mail remains nonreportable for Stripe/Tap but a fully valid `finance_tracker` payment with immutable Finance provenance is reportable.

- [x] **Step 2: Verify RED**

Run `npm test -- tests/approved-finance-payment.test.ts tests/b2c-payment-reportability.test.ts`. It must fail because the module and provenance input are absent.

- [x] **Step 3: Implement minimum rules**

Normalize only whitespace/case/punctuation; do not invent aliases beyond `ios` and `bank transfer`. Add optional `isApprovedFinancePayment` to the reportability input and bypass only `missing_customer_email` when true. All other gates remain unchanged.

- [x] **Step 4: Verify GREEN and commit**

Run the same tests; then commit the library and tests with `feat(b2c): define approved Finance payment rules`.

### Task 3: Add the Admin-only posting endpoint

**Files:**

- Create: `src/server/repositories/b2c-finance-ledger-repository.ts`
- Create: `src/app/api/admin/b2c/finance-ledger-posts/route.ts`
- Create: `tests/approved-finance-payment-api.test.ts`

**Interfaces:** `POST /api/admin/b2c/finance-ledger-posts` returns `{ result: { postedPayments, alreadyPostedPayments, skippedRows } }`.

- [x] **Step 1: Write failing route tests**

Assert a non-Admin gets 403 before database access. Assert an Admin calls only `post_approved_b2c_finance_payments` with `{}`. Assert an unknown RPC result becomes a safe 500 without raw source values, and the route does not query provider tables.

- [x] **Step 2: Verify RED**

Run `npm test -- tests/approved-finance-payment-api.test.ts`. It must fail because the route is absent.

- [x] **Step 3: Implement the repository and route**

Use the request-scoped server client and `getApprovedRole`. The repository invokes only the new RPC and validates the result with the pure mapper. The route accepts no request body and returns only the three safe counts.

- [x] **Step 4: Verify GREEN and commit**

Run the route test and commit with `feat(b2c): post approved Finance payments`.

### Task 4: Display Finance source records and post control

**Files:**

- Create: `src/features/b2c/b2c-approved-finance-posting.tsx`
- Modify: `src/features/b2c/b2c-reconciliation-page.tsx`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `tests/b2c-dashboard-repository.test.ts`
- Create: `tests/approved-finance-payment-ui.test.tsx`

**Interfaces:** `B2cApprovedFinancePosting({ onPosted }: { onPosted(): Promise<void> })`.

- [x] **Step 1: Write failing UI and repository tests**

Test an Admin sees “Post approved Finance payments” after Payment Tracker completion and a Viewer does not. Mock a successful result and assert clear posted/already/skipped text. Assert a linked `finance_tracker` record with metadata `bank_transfer` displays “Finance — Bank transfer”, iOS displays “Finance — iOS”, Finance contacts appear as source contacts, and reportability becomes true only when the payment ID has a provenance row.

- [x] **Step 2: Verify RED**

Run `npm test -- tests/approved-finance-payment-ui.test.tsx tests/b2c-dashboard-repository.test.ts`. It must fail because the control, source labels, and provenance query are absent.

- [x] **Step 3: Implement UI and ledger projection**

Render the Admin card only after Payment Tracker staging completes. State plainly that it adds valid iOS and bank-transfer Finance rows to the B2C ledger, does not alter the workbook, and does not create provider payments. Disable during posting and reload the safe summary only after success.

Add the bounded provenance-table read to the B2C dashboard snapshot. Pass `isApprovedFinancePayment` only when both source system and provenance link agree. Map source label from `source_metadata.finance_payment_method`; unknown metadata displays `Finance`, not a guess. Keep Stripe and Tap behavior unchanged.

- [x] **Step 4: Verify GREEN and commit**

Run the UI/repository tests and commit with `feat(b2c): show approved Finance ledger records`.

### Task 5: Document and fully verify

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/superpowers/plans/2026-08-17-approved-finance-payment-ledger.md`

- [x] **Step 1: Document the operating rule**

Record the approved method scope, duplicate behavior, immutable Finance-row link, missing-contact exception, source amount basis, Admin action, and manual migration requirement.

- [x] **Step 2: Full verification**

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`, and `git status --short`. All application checks must pass. Note if Supabase local tests cannot run because the CLI/local stack is unavailable.

- [x] **Step 3: Commit**

Commit documentation with `docs(b2c): document approved Finance ledger posting`.

## Plan Self-Review

- **Spec coverage:** Task 1 implements the transaction, provenance, duplicate protection, RLS, and audit. Task 2 narrows reportability. Task 3 protects the request boundary. Task 4 makes ledger behavior understandable. Task 5 documents and verifies it.
- **Placeholder scan:** each task names concrete files, tests, commands, behavior, and commit intent.
- **Type consistency:** Task 1 defines the RPC result consumed by Task 2, called in Task 3, and surfaced in Task 4. Task 4 uses the provenance table introduced by Task 1 with the reportability input introduced by Task 2.
