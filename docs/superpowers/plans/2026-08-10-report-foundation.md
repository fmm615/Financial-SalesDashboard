# Report Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a report foundation that can later accept approved B2C/B2B data without changing report jobs, artifacts, archive behavior, or delivery boundaries.

**Architecture:** Report generation consumes one `ReportDataSnapshot` rather than provider rows. A readiness gate derives `draft_fixture_only` or `financial_ready` from explicit coverage states; the PDF, CSV, archive metadata, and future delivery boundary receive the same snapshot. Existing durable jobs and private storage stay in place, with a `generation_mode` column ensuring the current worker can only process draft-fixture jobs.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Supabase PostgreSQL/Storage, Zod, Tailwind CSS.

## Global Constraints

- B2C and B2B data is not final: do not query, include, calculate, or present provider amounts in this foundation.
- Missing data is never zero; use `available`, `partial`, `not_loaded`, or `unavailable` coverage states.
- Only a `financial_ready` snapshot may be delivered by a future provider; delivery remains disabled in this plan.
- Admin writes use the authenticated request-scoped Supabase client; the protected worker uses the server-only service client.
- Report artifacts remain in the private `report-archives` bucket and downloads require approved access.
- Every slice adds focused tests and ends with a separate commit.

---

## File Structure

- Create: `src/lib/reports/report-data.ts` — report coverage, section, snapshot, and readiness domain contracts.
- Create: `src/lib/reports/report-readiness.ts` — pure readiness gate.
- Create: `tests/report-readiness.test.ts` — readiness gate known-value tests.
- Modify: `src/lib/reports/draft-report-content.ts` — converts a snapshot into consistent draft PDF/CSV content.
- Modify: `src/lib/reports/simple-pdf.ts` — retains one-page artifact rendering only.
- Modify: `tests/draft-report-content.test.ts` — verifies PDF/CSV carry the identical readiness disclosure.
- Create: `supabase/migrations/20260810110000_report_generation_metadata.sql` — report job generation mode and report metadata constraints.
- Modify: `src/types/database.generated.ts` — checked-in raw type snapshot matching the migration.
- Modify: `src/server/services/process-draft-report.ts` — creates snapshots, writes metadata, and processes draft jobs only.
- Modify: `src/app/api/reports/route.ts` and `src/app/api/reports/[jobId]/retry/route.ts` — create/requeue only draft jobs.
- Modify: `src/features/reports/reports-page.tsx` — shows readiness and coverage disclosure in the archive.
- Create: `src/lib/reports/delivery.ts` — disabled delivery provider contract.
- Create: `tests/report-delivery.test.ts` — proves draft reports cannot send.
- Modify: `README.md`, `docs/DATABASE_SCHEMA.md`, `docs/TESTING_STRATEGY.md` — document the final foundation boundary.

## Task 1: Report Snapshot and Readiness Gate

**Files:**

- Create: `src/lib/reports/report-data.ts`
- Create: `src/lib/reports/report-readiness.ts`
- Create: `tests/report-readiness.test.ts`

**Interfaces:**

- Produces `ReportCoverageStatus`, `ReportCoverage`, `ReportDataSnapshot`, `ReportReadiness`, `createDraftReportSnapshot`, and `getReportReadiness`.
- Consumes only a report type, period, and coverage records; it must not import B2C/B2B repositories.

- [ ] **Step 1: Write failing readiness tests**

```ts
expect(getReportReadiness([
  { area: "b2c", status: "available", message: "Loaded" },
  { area: "b2b", status: "available", message: "Loaded" },
])).toBe("financial_ready");

expect(getReportReadiness([
  { area: "b2c", status: "partial", message: "Backfill incomplete" },
])).toBe("draft_fixture_only");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/report-readiness.test.ts`

Expected: FAIL because the report domain modules do not exist.

- [ ] **Step 3: Implement the pure domain modules**

```ts
export type ReportCoverageStatus = "available" | "partial" | "not_loaded" | "unavailable";
export type ReportReadiness = "draft_fixture_only" | "financial_ready";

export function getReportReadiness(coverage: ReportCoverage[]): ReportReadiness {
  return coverage.every((item) => item.status === "available")
    ? "financial_ready"
    : "draft_fixture_only";
}
```

`createDraftReportSnapshot` must create B2C, B2B, targets, and pipeline coverage entries with `not_loaded`, a readable Finance-review explanation, `readiness: "draft_fixture_only"`, and `version: "1"`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- tests/report-readiness.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the self-contained slice**

```bash
git add src/lib/reports/report-data.ts src/lib/reports/report-readiness.ts tests/report-readiness.test.ts
git commit -m "feat(reports): add report readiness contract"
```

## Task 2: Snapshot-Driven Draft PDF and CSV

**Files:**

- Modify: `src/lib/reports/draft-report-content.ts`
- Modify: `tests/draft-report-content.test.ts`

**Interfaces:**

- Consumes `ReportDataSnapshot` from Task 1.
- Produces `DraftReportContent` with `pdfLines`, `csv`, and `summarySnapshot` that all carry the same `readiness` and coverage entries.

- [ ] **Step 1: Write failing artifact-consistency tests**

```ts
const snapshot = createDraftReportSnapshot({ reportType: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
const content = createDraftReportContent(snapshot);

expect(content.csv).toContain("draft_fixture_only");
expect(content.pdfLines.join(" ")).toContain("NOT FINANCIAL REPORTING");
expect(content.summarySnapshot).toMatchObject({ readiness: "draft_fixture_only", version: "1" });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/draft-report-content.test.ts`

Expected: FAIL because the renderer currently accepts a request rather than a snapshot.

- [ ] **Step 3: Make the renderer snapshot-driven**

Change `createDraftReportContent` to accept `ReportDataSnapshot`. Build the coverage rows from `snapshot.coverage`; each non-available status must render its message and must not render a numeric fallback. Store `{ version, readiness, coverage, period_start, period_end }` in `summarySnapshot`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- tests/draft-report-content.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the self-contained slice**

```bash
git add src/lib/reports/draft-report-content.ts tests/draft-report-content.test.ts
git commit -m "feat(reports): render draft artifacts from report snapshots"
```

## Task 3: Persist Generation and Readiness Metadata

**Files:**

- Create: `supabase/migrations/20260810110000_report_generation_metadata.sql`
- Modify: `src/types/database.generated.ts`
- Modify: `src/server/services/process-draft-report.ts`
- Modify: `src/app/api/reports/route.ts`
- Modify: `src/app/api/reports/[jobId]/retry/route.ts`

**Interfaces:**

- Adds `report_jobs.generation_mode` constrained to `draft_fixture` or `financial` and defaulting to `draft_fixture`.
- Adds `reports.snapshot_version` and `reports.readiness_status` constrained to `draft_fixture_only` or `financial_ready`.
- Produces archive records that expose generation mode, readiness, and snapshot version.

- [ ] **Step 1: Write migration/database contract tests**

Add assertions that the migration contains the generation/readiness constraints and add a service test asserting that a draft job writes `generation_mode: "draft_fixture"` and `readiness_status: "draft_fixture_only"`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- tests/database-foundation.test.ts tests/draft-report-content.test.ts`

Expected: FAIL because the metadata fields and worker restrictions do not exist.

- [ ] **Step 3: Add schema and worker behavior**

```sql
alter table public.report_jobs
  add column generation_mode text not null default 'draft_fixture'
  check (generation_mode in ('draft_fixture', 'financial'));

alter table public.reports
  add column snapshot_version text not null default '1',
  add column readiness_status text not null default 'draft_fixture_only'
  check (readiness_status in ('draft_fixture_only', 'financial_ready'));
```

Update the raw generated type snapshot. Queue routes set `generation_mode: "draft_fixture"`. The worker filters pending jobs by that mode, creates the Task 1 snapshot, and persists its version/readiness. It must refuse to process a `financial` job.

- [ ] **Step 4: Run focused checks**

Run: `npm run typecheck && npm test -- tests/database-foundation.test.ts tests/draft-report-content.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the self-contained slice**

```bash
git add supabase/migrations/20260810110000_report_generation_metadata.sql src/types/database.generated.ts src/server/services/process-draft-report.ts src/app/api/reports/route.ts src/app/api/reports/[jobId]/retry/route.ts tests/database-foundation.test.ts tests/draft-report-content.test.ts
git commit -m "feat(reports): persist report generation readiness metadata"
```

## Task 4: Archive Readiness and Coverage UX

**Files:**

- Modify: `src/server/services/process-draft-report.ts`
- Modify: `src/features/reports/reports-page.tsx`
- Modify: `tests/ui-system.test.tsx`

**Interfaces:**

- Extends `DraftReportArchiveItem` with `readinessStatus`, `snapshotVersion`, and `coverageSummary`.
- Displays `Draft — financial data not loaded` for draft reports and never displays a monetary report summary from a non-ready snapshot.

- [ ] **Step 1: Write the failing UI test**

```tsx
expect(screen.getByText("Draft — financial data not loaded")).toBeInTheDocument();
expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused UI test and verify it fails**

Run: `npm test -- tests/ui-system.test.tsx`

Expected: FAIL because the archive does not show readiness metadata.

- [ ] **Step 3: Extend archive reads and UI**

Read `reports.readiness_status` and `summary_snapshot` in the archive service. Render a status badge plus a concise coverage disclosure per job. Keep PDF/CSV links unavailable until artifact rows exist; retain error and retry visibility.

- [ ] **Step 4: Run the focused UI test and verify it passes**

Run: `npm test -- tests/ui-system.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the self-contained slice**

```bash
git add src/server/services/process-draft-report.ts src/features/reports/reports-page.tsx tests/ui-system.test.tsx
git commit -m "feat(reports): show report readiness in archive"
```

## Task 5: Disabled Delivery Boundary and Documentation

**Files:**

- Create: `src/lib/reports/delivery.ts`
- Create: `tests/report-delivery.test.ts`
- Modify: `src/server/services/process-draft-report.ts`
- Modify: `README.md`
- Modify: `docs/DATABASE_SCHEMA.md`
- Modify: `docs/TESTING_STRATEGY.md`

**Interfaces:**

- Produces `ReportDeliveryProvider` with `requestDelivery(input): Promise<ReportDeliveryResult>`.
- `DisabledReportDeliveryProvider` always returns `{ status: "disabled", reason: "Email delivery is not enabled." }` and accepts no recipient or credential.

- [ ] **Step 1: Write the failing delivery test**

```ts
const result = await new DisabledReportDeliveryProvider().requestDelivery({ reportId: "report-id", readiness: "draft_fixture_only" });
expect(result).toEqual({ status: "disabled", reason: "Email delivery is not enabled." });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/report-delivery.test.ts`

Expected: FAIL because the delivery boundary does not exist.

- [ ] **Step 3: Add the disabled provider and enforce it**

Implement the interface and inject `DisabledReportDeliveryProvider` into report processing. The worker must not create a `report_delivery_attempts` row, call an HTTP email API, or accept an email request while delivery is disabled. Update documentation to state that Resend can be added only after Finance validation.

- [ ] **Step 4: Run final checks**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit the self-contained slice**

```bash
git add src/lib/reports/delivery.ts tests/report-delivery.test.ts src/server/services/process-draft-report.ts README.md docs/DATABASE_SCHEMA.md docs/TESTING_STRATEGY.md
git commit -m "feat(reports): add disabled report delivery boundary"
```

## Review Checklist

- Task 1 covers coverage states and the readiness rule.
- Task 2 guarantees PDF, CSV, and archive metadata derive from one snapshot.
- Task 3 makes job mode and readiness queryable and blocks the draft worker from processing future financial jobs.
- Task 4 makes incomplete coverage visible rather than displaying zeroes.
- Task 5 creates a Resend-ready boundary that cannot send email today.
- No task reads unsettled B2C/B2B financial values.
