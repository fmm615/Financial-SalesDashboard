# Tap Statement Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin preview and atomically stage a complete Tap CSV as original-currency evidence without creating B2C revenue.

**Architecture:** A pure server parser accepts the known statement columns, retains all statement lines, and classifies their non-financial evidence kind. A multipart confirmation service re-parses and re-hashes the selected CSV, stores the original privately, and invokes one protected database function that creates the Tap import and evidence lines in a single transaction.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Node.js `crypto`, CSV parser, Supabase Auth/Storage/PostgreSQL, Vitest, Testing Library.

## Global Constraints

- Accept `.csv` only, with a UTF-8 BOM tolerated, at most 10 MiB and 20,000 non-blank lines.
- Require `postdate`, `txndate`, `description`, `currency`, `debit`, `credit`, `posting_id`, `charge_id`, and `refund_id` after trim/case normalization.
- Store every line as Tap evidence, including sales, fees, fee VAT, transfers, refunds, opening balances, and unknown lines.
- Keep currency and raw dates; never calculate a BHD/USD rate, total, or reportable revenue.
- Use `posting_id` as the unique Tap statement-row ID; reject duplicate IDs in the same file and preserve provider duplicate protection in the database.
- Preview is memory-only. Confirmation requires identical SHA-256 source hash, private Storage, Admin authorization, and atomic finalization.
- Return only safe counts to the browser: no raw lines, provider IDs, card details, customer values, storage path, or financial total.
- No writes to `b2c_payments`, no automatic matching/approval, and no Tap provider call.

---

### Task 1: Create protected Tap finalization and allow CSV source evidence

**Files:**
- Create: `supabase/migrations/20260812101000_finalize_tap_statement_import.sql`
- Modify: `src/types/database.generated.ts`, `supabase/tests/database_foundation.test.sql`, `docs/ARCHITECTURE.md`, `docs/INTEGRATIONS.md`, `docs/TESTING_STRATEGY.md`

**Produces:**
```sql
public.finalize_tap_statement_import(
  p_source_file_name text, p_source_file_sha256 text,
  p_source_storage_bucket text, p_source_storage_path text, p_rows jsonb
) returns uuid
```

- [ ] **Step 1: Write the failing database assertion**

Add a pgTAP assertion that a Tap source file cannot be duplicated by SHA-256 and that `b2c_provider_evidence` remains outside `b2c_payments`.

- [ ] **Step 2: Verify RED**

Run: `npm run supabase:test`

Expected: unavailable locally without the Supabase CLI; record this and retain the test for manual/local database verification.

- [ ] **Step 3: Add the migration**

Update `b2c-finance-imports` allowed MIME types to include `text/csv`. Define a security-definer function that requires `auth.uid()` and `public.is_admin()`, validates 1–20,000 object rows, valid provenance/hash, non-empty `postingId`, Tap kind, ISO currency, non-negative decimal debit/credit, and object raw payload. Insert `source_kind = 'tap_statement'`, then all provider evidence rows in one transaction, mark the import completed, and grant execution only to `authenticated`.

Example row payload:
```json
{"sourceRowNumber":2,"postingId":"1531493135","paymentId":"chg_LV07E1820241133Pp540201431","refundId":null,"kind":"sale","description":"Sale - FATIMA ABBAS","occurredAtRaw":"02/01/24 11:35 AM","currency":"BHD","credit":"74.570","debit":null,"rawPayload":{}}
```

- [ ] **Step 4: Update snapshot/docs and verify**

Add the RPC declaration to the generated type snapshot and document CSV source evidence/private staging. Run `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260812101000_finalize_tap_statement_import.sql supabase/tests/database_foundation.test.sql src/types/database.generated.ts docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/TESTING_STRATEGY.md
git commit -m "feat(b2c): add atomic Tap evidence staging"
```

### Task 2: Parse and classify Tap CSV statements safely

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/lib/validation/b2c-finance-import-contracts.ts`
- Create: `src/server/services/tap-statement-csv.ts`
- Test: `tests/tap-statement-csv.test.ts`

**Produces:**
```ts
export type ParsedTapStatement = {
  sourceFileName: string;
  sourceFileSha256: string;
  rows: TapStatementRow[];
};
export function parseTapStatementCsv(sourceFileName: string, bytes: Uint8Array): ParsedTapStatement;
```

- [ ] **Step 1: Write failing parser tests**

Use a hand-written CSV with a UTF-8 BOM and the sample Tap headers. Assert it classifies sale, processing fee, fee VAT, transfer, opening balance, refund, and unknown rows; preserves BHD and raw dates; rejects a missing required header, duplicate `posting_id`, negative decimal, non-CSV file, and 20,001 rows.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/tap-statement-csv.test.ts`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Add the minimal CSV dependency and parser**

Install `csv-parse`. Validate byte size/name before parsing. Use strict column parsing with empty field support. Convert only explicitly safe values into source strings. Use `classifyTapEvidence`; a date may remain raw/null and be counted as unparsed rather than guessed. Preserve all CSV columns in `rawPayload` and use `posting_id` as `providerRowId`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- tests/tap-statement-csv.test.ts && npm run typecheck && npm run lint`

```bash
git add package.json package-lock.json src/lib/validation/b2c-finance-import-contracts.ts src/server/services/tap-statement-csv.ts tests/tap-statement-csv.test.ts
git commit -m "feat(b2c): parse Tap statement evidence"
```

### Task 3: Add Admin-only Tap preview and confirmation routes

**Files:**
- Create: `src/lib/validation/tap-statement-upload-contracts.ts`
- Create: `src/server/services/tap-statement-upload.ts`
- Create: `src/app/api/admin/b2c/tap-statement/preview/route.ts`
- Create: `src/app/api/admin/b2c/tap-statement/finalize/route.ts`
- Test: `tests/tap-statement-upload-api.test.ts`

**Produces:**
```ts
type TapStatementPreview = {
  sourceFileSha256: string;
  totalRows: number;
  kindCounts: Record<TapEvidenceKind, number>;
  missingPaymentIdSales: number;
  unparsedDates: number;
};
```

- [ ] **Step 1: Write failing service/route tests**

Test a Viewer receives 403 before parsing. Test preview returns only safe counts and makes no Storage/RPC call. Test confirmation rejects mismatched hash before upload. Test matching Admin confirmation uploads one private CSV and calls `finalize_tap_statement_import`; an RPC failure removes its Storage object and returns a safe error.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/tap-statement-upload-api.test.ts`

Expected: FAIL because routes/services do not exist.

- [ ] **Step 3: Implement server orchestration**

Reuse single-file FormData validation and Node routes. Auth-check Admin before reading multipart content. Preview parses only in memory. Confirmation reparses, checks source hash, creates a random private `tap-statement/<hash>/<uuid>.csv` path, uploads `text/csv` with `upsert: false`, calls the atomic RPC through a focused repository method, and attempts cleanup after any finalization failure.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- tests/tap-statement-upload-api.test.ts tests/b2c-finance-reconciliation-api.test.ts && npm run typecheck && npm run lint`

```bash
git add src/lib/validation/tap-statement-upload-contracts.ts src/server/services/tap-statement-upload.ts src/app/api/admin/b2c/tap-statement/preview/route.ts src/app/api/admin/b2c/tap-statement/finalize/route.ts tests/tap-statement-upload-api.test.ts
git commit -m "feat(b2c): add private Tap statement upload"
```

### Task 4: Add controlled Tap upload UI and complete verification

**Files:**
- Modify: `src/features/b2c/b2c-reconciliation-page.tsx`, `tests/b2c-finance-reconciliation-ui.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Assert Viewer sees no Tap file control. As Admin, choose a `.csv`, preview safe kind counts, and enable only then **Confirm staged import**. Assert no BHD/USD amount, raw row, or customer detail appears.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/b2c-finance-reconciliation-ui.test.tsx`

Expected: FAIL because Tap controls are absent.

- [ ] **Step 3: Implement the separate Tap section**

Place it below Payment Tracker. Use file input accepting `.csv,text/csv`, an independent file/preview/error/pending state, and URLs `/api/admin/b2c/tap-statement/preview` and `/finalize`. On success clear Tap state and refresh only safe coverage.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/tap-statement-csv.test.ts tests/tap-statement-upload-api.test.ts tests/b2c-finance-reconciliation-ui.test.tsx && npm run typecheck && npm run lint && npm run build`

```bash
git add src/features/b2c/b2c-reconciliation-page.tsx tests/b2c-finance-reconciliation-ui.test.tsx
git commit -m "feat(b2c): add Tap statement upload controls"
```

### Task 5: Hand off safely

- [ ] **Step 1: Check the feature boundary**

Run: `rg -n "b2c_payments|amountUsd|BHD" src/app/api/admin/b2c/tap-statement src/server/services/tap-statement-upload.ts src/features/b2c/b2c-reconciliation-page.tsx`

Expected: no Tap upload write to `b2c_payments` and no UI total/conversion.

- [ ] **Step 2: Push verified commits and give migration instructions**

Confirm `git remote -v` is `https://github.com/fmm615/Financial-SalesDashboard.git`, push `main`, and direct the user to apply `20260812101000_finalize_tap_statement_import.sql` before their first Tap confirmation.

## Self-Review

Task 1 creates the database/storage boundary. Task 2 handles exact file parsing and classifications. Task 3 provides secure server staging. Task 4 adds the independent safe UI. Task 5 verifies the no-revenue boundary and handoff. The plan never converts BHD, totals Tap evidence, discards non-sale lines, or begins Stripe work.
