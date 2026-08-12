# Payment Tracker Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an Admin to preview and explicitly stage the Finance Payment Tracker's `B2C` and `B2C Cons` worksheets without publishing B2C revenue or changing provider payments.

**Architecture:** A Node.js server-side workbook parser converts only the two approved tabs into the existing strictly validated Finance-row contract. Preview is memory-only. Confirmation re-parses and re-hashes the same `.xlsx`, uploads the original to a new private Supabase bucket, and calls the existing atomic `finalize_b2c_finance_import` RPC; cleanup is attempted if finalization fails. The client presents only a safe quality summary and does not receive raw customer rows.

**Tech Stack:** Next.js App Router, TypeScript, Zod, ExcelJS, Supabase Auth/Storage/PostgreSQL, Vitest, Testing Library.

## Global Constraints

- Only `B2C` and `B2C Cons` tabs are accepted; both must be present exactly once.
- Payment Tracker values are USD revenue candidates excluding customer VAT, not published revenue.
- The upload must never write `b2c_payments`, calculate a B2C Finance total, or make an approval/reconciliation decision.
- Require server-side Admin authorization; browser role checks are presentation only.
- Accept `.xlsx` only: reject `.xls`, `.csv`, `.xlsm`, malformed/non-ZIP files, files over 10 MiB, and more than 20,000 extracted rows.
- Parse displayed/cached values only; never calculate a workbook formula. Reject a source formula that has no cached result.
- Preserve source hash, filename, tab, one-based row number, and raw mapped cells. Do not repair dates, amounts, identities, or duplicates.
- Recompute SHA-256 on confirmation and require it to equal the reviewed preview hash. Exact file-hash duplicate protection remains enforced by the database.
- Original confirmed files go only to a private bucket. Return no storage path or raw customer payload to the browser.
- Follow test-driven development. Update architecture, integration, project-structure, testing, and setup documentation with the Storage boundary.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server/services/payment-tracker-workbook.ts` | Pure `.xlsx` safety checks, tab/header mapping, source hash, and pre-parsed Finance rows. |
| `src/server/services/payment-tracker-upload.ts` | Builds a safe preview and handles private upload → atomic stage → cleanup orchestration. |
| `src/lib/validation/payment-tracker-upload-contracts.ts` | Limits and Zod contracts for multipart confirmation metadata and UI-safe preview responses. |
| `src/app/api/admin/b2c/payment-tracker/preview/route.ts` | Thin authenticated multipart preview endpoint. |
| `src/app/api/admin/b2c/payment-tracker/finalize/route.ts` | Thin authenticated multipart confirmation endpoint. |
| `src/features/b2c/b2c-reconciliation-page.tsx` | Admin-only file selection, preview, explicit confirmation, and coverage refresh UI. |
| `supabase/migrations/20260812093000_b2c_finance_upload_storage.sql` | Private source-file bucket plus Admin-only storage policies. |
| `tests/payment-tracker-workbook.test.ts` | Parser safety and mapping unit tests. |
| `tests/payment-tracker-upload-api.test.ts` | Auth, hash match, Storage cleanup, and atomic finalization route/service tests. |
| `tests/b2c-finance-reconciliation-ui.test.tsx` | Admin upload controls and safe UI-state tests. |

### Task 1: Establish private source-file storage

**Files:**
- Create: `supabase/migrations/20260812093000_b2c_finance_upload_storage.sql`
- Modify: `docs/ARCHITECTURE.md`, `docs/INTEGRATIONS.md`, `docs/PROJECT_STRUCTURE.md`, `docs/TESTING_STRATEGY.md`
- Test: `supabase/tests/database_foundation.test.sql`

**Consumes:** Existing Admin RLS helper `public.is_admin()` and `b2c_finance_imports.source_storage_bucket/source_storage_path`.

**Produces:** Private `b2c-finance-imports` bucket which permits only authenticated Admin insert/delete/select operations and permits only the approved `.xlsx` MIME type up to 10 MiB.

- [ ] **Step 1: Write the failing database contract assertion**

Add an assertion that `storage.buckets` contains `b2c-finance-imports`, that it is private, and that `storage.objects` policies contain no anonymous or Viewer write policy.

- [ ] **Step 2: Run the database contract test to verify it fails**

Run: `npm run supabase:test`

Expected: the new bucket assertion fails until the migration is applied to a local Supabase instance. If the Supabase CLI is unavailable, record that limitation and run the application tests instead.

- [ ] **Step 3: Add the migration**

Create the bucket with `public = false`, `file_size_limit = 10485760`, and `allowed_mime_types = ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']`. Enable narrowly scoped Admin policies for `INSERT`, `SELECT`, and `DELETE` on `storage.objects` where `bucket_id = 'b2c-finance-imports'`; do not add update, public, or anonymous access.

- [ ] **Step 4: Document the boundary**

State that confirmed original Payment Tracker files are private, Admin-controlled source evidence and are not a public report archive or a provider import. State that Tap and Stripe require their own later upload boundaries.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint`

Commit:
```bash
git add supabase/migrations/20260812093000_b2c_finance_upload_storage.sql supabase/tests/database_foundation.test.sql docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/PROJECT_STRUCTURE.md docs/TESTING_STRATEGY.md
git commit -m "feat(b2c): add private payment tracker storage"
```

### Task 2: Parse the approved workbook safely

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/server/services/payment-tracker-workbook.ts`
- Test: `tests/payment-tracker-workbook.test.ts`

**Consumes:** `FinanceWorkbookRowInput` from `b2c-finance-import-contracts.ts` and `assessFinanceImport` from `b2c-finance-reconciliation.ts`.

**Produces:**
```ts
export type ParsedPaymentTrackerWorkbook = {
  sourceFileName: string;
  sourceFileSha256: string;
  acceptedTabs: ["B2C", "B2C Cons"];
  rows: Array<FinanceWorkbookRowInput & { rawPayload: Record<string, unknown> }>;
};
export function parsePaymentTrackerWorkbook(sourceFileName: string, bytes: Uint8Array): Promise<ParsedPaymentTrackerWorkbook>;
```

- [ ] **Step 1: Write failing parser tests**

Use ExcelJS in test fixtures to create an in-memory `.xlsx` containing the headers below and one row in each tab. Assert normalized header mapping, one-based source row numbers, raw cell retention, and a lowercase SHA-256 string.

```ts
expect(parsed.rows).toEqual(expect.arrayContaining([
  expect.objectContaining({ sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2025-10-05", amountUsdRaw: "475", paymentMethodRaw: "Stripe" }),
  expect.objectContaining({ sourceTab: "B2C Cons", sourceRowNumber: 2, declaredMonth: "October", membershipTypeRaw: "Individual Membership Plan" }),
]));
```

Also add individual tests that reject: a missing approved tab, an absent required header (`Date`, amount, `Name`, or `Pay Method`), repeated required header, `.xlsm`/`.csv` filename, non-ZIP bytes, more than 20,000 rows, and a formula cell lacking a cached result.

- [ ] **Step 2: Run parser tests to verify they fail**

Run: `npm test -- tests/payment-tracker-workbook.test.ts`

Expected: FAIL because the parser module does not yet exist.

- [ ] **Step 3: Install the maintained server-side workbook dependency**

Run: `npm install exceljs`

Use ExcelJS only in server services and tests. Do not use a browser spreadsheet parser or evaluate formulas.

- [ ] **Step 4: Implement the parser**

Reject files before workbook loading unless filename ends in `.xlsx` case-insensitively, bytes are non-empty and no more than 10 MiB, and the ZIP signature starts with `PK`. Load bytes with ExcelJS. Require exact sheet names `B2C` and `B2C Cons`; map headers after trim/lowercase normalization; require exactly one of each required header. Scan the first ten nonempty rows for a header row, then retain nonempty rows below it.

Map `B2C` headers: `Date`, `Amount USD`, `Name`, `Mobile`, `Type`, `Pay Method`, `Payment Status`, `year`, `Note`. Map `B2C Cons`: `Date`, `Amount`, `Name`, `Mobile`, `Category`, `Membership Type`, `Pay Method`, `Payment Status`, `Month`, `Year`, `Note`. Preserve all accepted header/value pairs in `rawPayload`. Convert a true date cell to `YYYY-MM-DD`; retain numeric values as text. A formula may use its primitive cached result only, otherwise throw a safe parser error; never run calculations. Hash original bytes with SHA-256.

- [ ] **Step 5: Run parser tests to verify they pass**

Run: `npm test -- tests/payment-tracker-workbook.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/services/payment-tracker-workbook.ts tests/payment-tracker-workbook.test.ts
git commit -m "feat(b2c): parse payment tracker workbooks safely"
```

### Task 3: Add server-side preview and confirmation orchestration

**Files:**
- Create: `src/lib/validation/payment-tracker-upload-contracts.ts`
- Create: `src/server/services/payment-tracker-upload.ts`
- Create: `src/app/api/admin/b2c/payment-tracker/preview/route.ts`
- Create: `src/app/api/admin/b2c/payment-tracker/finalize/route.ts`
- Test: `tests/payment-tracker-upload-api.test.ts`

**Consumes:** `parsePaymentTrackerWorkbook`, `assessFinanceImport`, `SupabaseB2cFinanceReconciliationRepository.finalizeFinanceImport`, request-scoped `createServerSupabaseClient`, and private `b2c-finance-imports` Storage.

**Produces:**
```ts
type PaymentTrackerPreview = {
  sourceFileSha256: string;
  acceptedTabs: ["B2C", "B2C Cons"];
  summary: FinanceImportAssessment["summary"];
  issueCounts: Record<string, number>;
  duplicateCandidates: { exact: number; possible: number; conflicts: number };
};
```

- [ ] **Step 1: Write failing API/service tests**

Mock the authenticated request client and test these cases:

```ts
expect(await previewRoute(viewerMultipartRequest)).toHaveProperty("status", 403);
expect(await finalizeRoute(mismatchedHashRequest)).toHaveProperty("status", 422);
expect(storageUpload).not.toHaveBeenCalled();
```

For a confirmed Admin file with a matching hash, assert one Storage `upload`, one `finalize_b2c_finance_import` RPC, and a `201` response. For an RPC failure after upload, assert one `storage.remove([path])`, a safe `422` response, and no `b2c_payments` call. Assert preview performs no Storage/RPC write.

- [ ] **Step 2: Run API tests to verify they fail**

Run: `npm test -- tests/payment-tracker-upload-api.test.ts`

Expected: FAIL because multipart routes and upload service do not exist.

- [ ] **Step 3: Implement strict multipart contracts and safe preview service**

Accept one `file` field that is a web `File`; reject missing/multiple/non-file values. Require confirmation `expectedFileSha256` to match `/^[0-9a-f]{64}$/`. Parse bytes with the pure parser and form an existing `FinanceImportRequestInput` only inside the server using the fixed bucket name and a server-generated UUID path. Assess rows with the existing service. Derive issue counts and pairwise duplicate-candidate counts from the assessment without returning names, amounts, raw rows, or provider IDs.

- [ ] **Step 4: Implement confirmation side effects and thin routes**

Set `export const runtime = "nodejs"` in both routes. In each route, authenticate with `getUser()` and require `getApprovedRole(...) === "admin"` before parsing multipart content. Preview returns the safe preview only. Finalize re-parses bytes, rejects hash mismatch before Storage, uploads the unchanged original bytes with MIME type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `upsert: false`, invokes the repository's atomic finalizer, and attempts `remove([path])` if finalization throws. Return only `{ importId }` on success and a safe message on failure.

- [ ] **Step 5: Run API tests to verify they pass**

Run: `npm test -- tests/payment-tracker-upload-api.test.ts tests/b2c-finance-reconciliation-api.test.ts`

Expected: PASS; existing pre-parsed import routes remain unchanged and continue to be covered.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/payment-tracker-upload-contracts.ts src/server/services/payment-tracker-upload.ts src/app/api/admin/b2c/payment-tracker/preview/route.ts src/app/api/admin/b2c/payment-tracker/finalize/route.ts tests/payment-tracker-upload-api.test.ts
git commit -m "feat(b2c): add confirmed payment tracker staging"
```

### Task 4: Add the controlled Admin upload UI

**Files:**
- Modify: `src/features/b2c/b2c-reconciliation-page.tsx`
- Modify: `tests/b2c-finance-reconciliation-ui.test.tsx`

**Consumes:** Safe coverage `GET /api/b2c/reconciliation`, Admin role from `useCanManage`, preview endpoint, and finalize endpoint.

**Produces:** An Admin-only `Payment Tracker upload` section that can request a preview, show non-financial result counts, and explicitly stage the same file.

- [ ] **Step 1: Write failing UI tests**

Render as a Viewer and assert the file control and confirmation button are absent. Render as Admin, select a `.xlsx` test File, mock a safe preview response, and assert the UI shows source hash/counts and enables `Confirm staged import`. Assert confirmation is disabled before preview, disabled while a request is outstanding, and remains absent from any claimed Finance revenue total.

- [ ] **Step 2: Run the UI test to verify it fails**

Run: `npm test -- tests/b2c-finance-reconciliation-ui.test.tsx`

Expected: FAIL because no upload controls or preview state exist.

- [ ] **Step 3: Implement the UI without financial logic**

Use a labelled `<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">`; retain the selected browser File only in component state. The Preview control sends `FormData({ file })` to `/api/admin/b2c/payment-tracker/preview`. Present filename, hash, accepted tabs, extracted row count, quality counts, issue counts, and duplicate-candidate counts as staging/review information. Do not display a sum, per-row data, customer data, storage location, or a publication control.

On confirm, send the same File and preview hash to `/api/admin/b2c/payment-tracker/finalize`. Disable both actions while pending. On success, clear selected/preview state, announce that rows are staged and non-reportable, and refresh the safe coverage summary. On failure, show the returned safe error without clearing the existing successful preview.

- [ ] **Step 4: Run the UI test to verify it passes**

Run: `npm test -- tests/b2c-finance-reconciliation-ui.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/b2c/b2c-reconciliation-page.tsx tests/b2c-finance-reconciliation-ui.test.tsx
git commit -m "feat(b2c): add payment tracker upload controls"
```

### Task 5: Verify the complete feature and hand off the migration

**Files:**
- Modify only if verification exposes a real issue.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- tests/payment-tracker-workbook.test.ts tests/payment-tracker-upload-api.test.ts tests/b2c-finance-reconciliation-api.test.ts tests/b2c-finance-reconciliation-ui.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run: `npm run typecheck && npm run lint && npm run build`

Expected: all commands succeed. Restore a generated-only `tsconfig.tsbuildinfo` change before committing if it is the sole unintended artifact.

- [ ] **Step 3: Check source safety**

Run: `rg -n "b2c_payments|sourceStoragePath|payment-tracker" src/app/api/admin/b2c/payment-tracker src/server/services/payment-tracker-upload.ts src/features/b2c/b2c-reconciliation-page.tsx`

Expected: no write to `b2c_payments`, no browser rendering of a Storage path, and no B2C Finance total.

- [ ] **Step 4: Commit verification-only fixes if required and push each intentional commit**

Use explicit paths with `git add`; verify `git remote -v` remains `https://github.com/fmm615/Financial-SalesDashboard.git` before `git push origin main`.

- [ ] **Step 5: Hand off the manual migration**

Tell the user to apply `supabase/migrations/20260812093000_b2c_finance_upload_storage.sql` in Supabase before attempting their first upload. Explain that this feature stages the Payment Tracker only; Tap CSV, Stripe export, reconciliation decisions, and Finance period approval remain later, separate work.

## Self-Review

**Spec coverage:** Task 1 provides the private original-file archive and RLS boundary. Task 2 covers tabs, column mapping, strict XLSX/formula/size/row validation, hash, and raw source retention. Task 3 covers Admin-only multipart preview/finalization, double parsing, hash match, storage cleanup, and safe response. Task 4 provides the controlled UI states. Task 5 performs full verification and manual-migration handoff. No task publishes revenue, resolves a duplicate, changes a provider record, or parses Tap/Stripe.

**Placeholder scan:** No placeholder or generic validation/testing step remains; each task lists concrete behaviour and commands.

**Type consistency:** `parsePaymentTrackerWorkbook` supplies the exact existing Finance-row shape consumed by `assessFinanceImport`; the upload service supplies `FinanceImportRequestInput` to `finalizeFinanceImport`; only the safe `PaymentTrackerPreview` crosses to the browser.
