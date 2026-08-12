# B2C Finance Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Admin-only staged import and reconciliation foundation for the `B2C`/`B2C Cons` Finance workbook tabs and Tap statement rows, without publishing a financial total.

**Architecture:** Immutable imports retain source-file provenance and staging rows before any B2C payment is created. Reconciliation groups link one selected Finance revenue row to overlapping Finance rows and provider evidence. An incomplete, duplicate, conflicting, or unapproved group cannot be reportable.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Zod, Vitest, Supabase PostgreSQL, RLS, Storage, and PostgreSQL audit triggers.

## Global Constraints

- Only workbook tabs named `B2C` and `B2C Cons` are accepted for the first Finance workbook source.
- Finance workbook revenue is USD and excludes customer VAT; it is the only candidate reporting-revenue value.
- Stripe and Tap evidence never add another revenue row; provider fees, provider-fee VAT, transfers, and opening balances are never sales.
- Do not infer a BHD-to-USD rate for Tap.
- Retain raw source row payloads, source tab, source row, source file hash, and actor for audit.
- Never auto-correct a date from a conflicting month label or swap day/month values.
- Missing, zero-value, duplicate-candidate, and conflict rows do not become financial totals.
- Every write is Admin-only through an authenticated request-scoped client and RLS. No delete policy is created.
- Use decimal strings at TypeScript boundaries and `numeric(20,6)` in PostgreSQL.
- The complete Stripe Charges export remains a required later source before a period can be marked verified.
- This foundation accepts only validated, pre-parsed source rows. Reading a raw `.xlsx` file in the application is a separate, explicit implementation step; a file must never be marked imported merely because it was uploaded.

---

## File Structure

- `supabase/migrations/20260812090000_b2c_finance_reconciliation_staging.sql`: immutable import, Finance staging, provider evidence, reconciliation, RLS, and audit schema.
- `supabase/tests/database_foundation.test.sql`: pgTAP identity, file-hash, and RLS assertions.
- `src/types/database.generated.ts`: staging table and enum contracts.
- `src/lib/validation/b2c-finance-import-contracts.ts`: strict workbook/Tap row and Admin-decision contracts.
- `src/server/services/b2c-finance-reconciliation.ts`: pure parsing, date-quality, duplicate-candidate, Tap classification, and publication-gate rules.
- `src/server/repositories/b2c-finance-reconciliation-repository.ts`: request-scoped persistence only.
- `supabase/migrations/20260812091000_finalize_b2c_finance_import.sql`: authenticated, atomic persistence for one already-parsed Finance workbook import.
- `src/app/api/admin/b2c/finance-imports/**/route.ts`: Admin preview and finalize routes.
- `src/app/api/b2c/reconciliation/route.ts`: approved-user safe summary read.
- `src/features/b2c/b2c-reconciliation-page.tsx`: safe coverage and reconciliation-foundation summary.
- `tests/b2c-finance-reconciliation*.test.ts*`: service, API, and UI test coverage.

### Task 1: Add immutable staging and reconciliation schema

**Files:**

- Create: `supabase/migrations/20260812090000_b2c_finance_reconciliation_staging.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `supabase/tests/database_foundation.test.sql`
- Modify: `tests/database-foundation.test.ts`

**Interfaces:**

- Produces `b2c_finance_imports`, `b2c_finance_staging_rows`, `b2c_provider_evidence`, `b2c_reconciliation_groups`, `b2c_reconciliation_finance_rows`, `b2c_reconciliation_provider_evidence`, and `b2c_reconciliation_decisions`.
- `b2c_finance_imports.source_kind` is `payment_tracker`, `tap_statement`, or `stripe_charges`.
- Import file hashes are unique; source rows are unique by import, tab, and one-based row number.

- [x] **Step 1: Write failing database contract tests**

Add TypeScript migration assertions for table names, source-file hash uniqueness, `B2C`/`B2C Cons` tab constraints, Tap transaction kinds, and RLS. Add pgTAP cases that reject an identical SHA-256 hash and reject a `payment_tracker` staging row with another tab name.

```ts
expect(migration).toContain("unique (source_file_sha256)");
expect(migration).toContain("source_tab in ('B2C', 'B2C Cons')");
expect(migration).toContain("transaction_kind in ('sale', 'processing_fee', 'fee_vat', 'refund', 'transfer', 'opening_balance', 'needs_review')");
```

- [x] **Step 2: Run test to verify it fails**

Run `npm run test -- tests/database-foundation.test.ts`. Expected: FAIL because the migration is absent.

- [x] **Step 3: Create the migration**

Create enums for import state (`pending`, `processing`, `completed`, `failed`), Finance row quality (`valid`, `zero_value`, `needs_review`, `invalid`), reconciliation state (`unmatched`, `exact_duplicate_candidate`, `possible_duplicate`, `conflict`, `canonical`, `excluded`), source kind, and provider evidence kind.

`b2c_finance_imports` stores source kind, original filename, SHA-256 hash, private Storage location, durable state/timestamps, safe error, and authenticated `imported_by`. `b2c_finance_staging_rows` stores raw cells plus normalized comparison fields. Its tab constraint permits only `B2C` and `B2C Cons` for `payment_tracker`; parsed money/date fields are nullable to retain bad input without converting it to zero.

`b2c_provider_evidence` stores immutable Tap/Stripe evidence, original amount/currency, payment ID, provider row ID, transaction kind, and raw payload. A unique provider-row reference prevents repeated Tap statement lines while allowing one payment ID on sale, fee, and fee-VAT lines.

Create reconciliation groups with typed Finance and provider link tables. A decision stores Admin reason, selected canonical Finance row, actor, and timestamp. No schema path inserts into `b2c_payments`. Enable RLS, create Admin-only read/write policies, omit delete policies, attach audit triggers, and add indexes for hash, comparison keys, payment ID, and state.

- [x] **Step 4: Update generated contracts manually**

Add exact `Database` table and enum entries. Use `Decimal` for monetary columns and literal unions for states.

- [x] **Step 5: Run verification**

Run `npm run test -- tests/database-foundation.test.ts`, `npm run typecheck`, `npm run lint`, and `git diff --check`. Expected: every command exits `0`.

- [x] **Step 6: Commit**

Run `git add supabase/migrations/20260812090000_b2c_finance_reconciliation_staging.sql supabase/tests/database_foundation.test.sql src/types/database.generated.ts tests/database-foundation.test.ts` then `git commit -m "feat(b2c): add reconciliation staging schema"`.

### Task 2: Add strict contracts and pure reconciliation rules

**Files:**

- Create: `src/lib/validation/b2c-finance-import-contracts.ts`
- Create: `src/server/services/b2c-finance-reconciliation.ts`
- Create: `tests/b2c-finance-reconciliation.test.ts`

**Interfaces:**

- Produces `financeWorkbookRowSchema`, `tapEvidenceRowSchema`, `reconciliationDecisionSchema`, `assessFinanceRow`, `classifyTapEvidence`, and `compareFinanceRows`.
- `assessFinanceRow` returns retained quality, safe parsed values, and validation issues; it never repairs an ambiguous date.

- [x] **Step 1: Write failing unit tests**

Test that only accepted tabs pass; zero amount returns `zero_value`; missing payment method returns `needs_review`; date/month mismatch returns `needs_review` with original date retained; an identical identity/date/amount/method pair returns `exact_duplicate_candidate`; a same-day identity/amount mismatch returns `conflict`; and a later recurring payment stays `unmatched`.

```ts
expect(assessFinanceRow({ sourceTab: "B2C Cons", sourceRowNumber: 2, reportedDateRaw: "45787", declaredMonth: "October", declaredYear: "2025", amountUsdRaw: "475", customerNameRaw: "Reham Garash", paymentMethodRaw: "Stripe" }).quality).toBe("needs_review");
expect(classifyTapEvidence({ description: "Transfer - AUB XXXX7002", chargeId: null, currency: "BHD", debit: "0", credit: "100" }).kind).toBe("transfer");
```

- [x] **Step 2: Run test to verify it fails**

Run `npm run test -- tests/b2c-finance-reconciliation.test.ts`. Expected: FAIL because contracts and service are absent.

- [x] **Step 3: Implement minimal contracts and pure functions**

Accept raw strings. Parse money only when it is a non-negative decimal. Parse known Excel serial or unambiguous `dd/mm/yyyy` values without mutating source text. Use date/month/year to detect a conflict only. Normalize e-mail, phone, and name only for comparison. Prefer e-mail identity; without it require normalized name, payment method, and amount before proposing a duplicate.

Classify Tap only by exact prefix/field rules: `Sale -` is `sale`; `Fee - Transaction Processing` is `processing_fee`; `VAT - Transaction Processing` is `fee_vat`; `Transfer -` is `transfer`; `Opening Balance` is `opening_balance`; a populated refund ID is `refund`; all other lines are `needs_review`. Reject a sale without charge ID. Never calculate USD from BHD.

- [x] **Step 4: Run test to verify it passes**

Run `npm run test -- tests/b2c-finance-reconciliation.test.ts`. Expected: PASS.

- [x] **Step 5: Commit**

Run `git add src/lib/validation/b2c-finance-import-contracts.ts src/server/services/b2c-finance-reconciliation.ts tests/b2c-finance-reconciliation.test.ts` then `git commit -m "feat(b2c): validate staged reconciliation rows"`.

### Task 3: Persist preview imports and audited decisions

**Files:**

- Create: `src/server/repositories/b2c-finance-reconciliation-repository.ts`
- Create: `supabase/migrations/20260812091000_finalize_b2c_finance_import.sql`
- Create: `src/app/api/admin/b2c/finance-imports/preview/route.ts`
- Create: `src/app/api/admin/b2c/finance-imports/finalize/route.ts`
- Create: `src/app/api/admin/b2c/reconciliation/[groupId]/decision/route.ts`
- Create: `tests/b2c-finance-reconciliation-api.test.ts`

**Interfaces:**

- Preview returns row-quality summaries without creating reportable payments.
- Finalize persists one immutable import and retained, already-parsed rows, returning an import ID. It does not parse spreadsheet bytes.
- Decision requires `canonicalFinanceRowId`, `canonical` or `excluded`, and a Finance reason.

- [x] **Step 1: Write failing API tests**

Mock unauthenticated and Admin users. Assert every write is `403` for unauthenticated callers, invalid bodies are `422`, and finalized imports do not invoke any `b2c_payments` write.

- [x] **Step 2: Run test to verify it fails**

Run `npm run test -- tests/b2c-finance-reconciliation-api.test.ts`. Expected: FAIL because routes and repository are absent.

- [x] **Step 3: Implement repository and thin routes**

Preview uses pure service logic only. The repository uses a `security definer` SQL function to persist one already-parsed Finance workbook import and every staged row atomically; a PostgREST sequence of independent inserts is not permitted. Finalize verifies an Admin and accepts strict, already-parsed rows from a future trusted parser. It does not accept raw spreadsheet bytes. Decision verifies an Admin and writes an append-only decision before state advancement.

- [x] **Step 4: Run verification**

Run `npm run test -- tests/b2c-finance-reconciliation-api.test.ts`, `npm run typecheck`, and `npm run lint`. Expected: every command exits `0`.

- [x] **Step 5: Commit**

Run `git add src/server/repositories/b2c-finance-reconciliation-repository.ts src/app/api/admin/b2c/finance-imports src/app/api/admin/b2c/reconciliation tests/b2c-finance-reconciliation-api.test.ts` then `git commit -m "feat(b2c): add secured reconciliation imports"`.

### Task 4: Add safe reconciliation summary and coverage UI

**Files:**

- Create: `src/app/api/b2c/reconciliation/route.ts`
- Create: `src/features/b2c/b2c-reconciliation-page.tsx`
- Create: `src/app/operations/b2c/reconciliation/page.tsx`
- Modify: `src/components/app-shell.tsx`
- Create: `tests/b2c-finance-reconciliation-ui.test.tsx`

**Interfaces:**

- `GET /api/b2c/reconciliation` returns UI-safe counts and coverage state.
- Page always says `Not fully loaded` until all sources complete and Finance approves a period.

- [x] **Step 1: Write failing UI tests**

Test source states, `Not fully loaded`, unresolved count, no claimed B2C revenue total, and no Admin decision control for a Viewer.

```tsx
expect(await screen.findByText("Not fully loaded")).toBeInTheDocument();
expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "Approve canonical sale" })).not.toBeInTheDocument();
```

- [x] **Step 2: Run test to verify it fails**

Run `npm run test -- tests/b2c-finance-reconciliation-ui.test.tsx`. Expected: FAIL because the page is absent.

- [x] **Step 3: Implement safe summary and coverage page**

Return no provider payload, contact details, or raw source rows to the Viewer route. Show source state, staged quality/unresolved counts, and publication gate. Admin decisions are always server submitted/audited. The page never calculates a final B2C total or claims a verified period.

- [x] **Step 4: Run verification**

Run `npm run test -- tests/b2c-finance-reconciliation-ui.test.tsx`, `npm run typecheck`, and `npm run lint`. Expected: every command exits `0`.

- [x] **Step 5: Commit**

Run `git add src/app/api/b2c/reconciliation src/features/b2c/b2c-reconciliation-page.tsx src/app/operations/b2c/reconciliation/page.tsx src/components/app-shell.tsx tests/b2c-finance-reconciliation-ui.test.tsx` then `git commit -m "feat(b2c): add reconciliation review foundation"`.

### Task 5: Document and verify the staged boundary

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/superpowers/plans/2026-08-12-b2c-finance-reconciliation.md`

- [x] **Step 1: Update documentation and plan checkboxes**

Document source provenance, workbook tab scope, Tap BHD evidence boundary, duplicate/conflict gate, no automatic date repair, and required Stripe coverage.

- [x] **Step 2: Run final verification**

Run `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`, and `git status --short`. Expected: application commands exit `0`; database pgTAP remains explicitly dependent on a local Supabase CLI and manual migration application.

- [ ] **Step 3: Commit**

Run `git add docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/PROJECT_STRUCTURE.md docs/TESTING_STRATEGY.md docs/superpowers/plans/2026-08-12-b2c-finance-reconciliation.md` then `git commit -m "docs(b2c): document reconciliation controls"`.
