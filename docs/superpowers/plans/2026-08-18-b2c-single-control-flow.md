# B2C Completion and Single Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish B2C with one simple Admin workspace while preventing repeated Payment Tracker snapshots, provider retries, corrections, refunds, and evidence imports from double-counting financial records.

**Architecture:** Preserve Stripe, Tap, workbook, and statement rows as immutable source evidence. Fix Finance-workbook identity before simplifying the UI, then expose one derived work-item layer through a single `/operations/b2c` workspace with `Work queue`, `Ledger`, and `Sources` tabs. Clean provider payments become reportable automatically when all approved rules pass; only exceptions, corrections, FX, duplicates, Finance Tracker posting, and manual bank transfers require an Admin decision.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Supabase PostgreSQL/RLS, Tailwind CSS, Vitest, Testing Library, Playwright, pgTAP.

**Spec:** `docs/BUSINESS_RULES.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE_RULES.md`, `docs/SECURITY.md`, `docs/TESTING_STRATEGY.md`, `docs/INTEGRATIONS.md`, `docs/PLAYBOOK_REQUIREMENTS_REFERENCE.md`, and `docs/superpowers/specs/2026-08-17-b2c-finance-workspace-and-adjustments-design.md`.

## Progress & amendments

Kept current as work happens, not just at task boundaries — this is the living status, the numbered tasks below are the original spec.

**Status as of 2026-08-20:** Tasks 1-6 complete and merged. Task 7 not started.

- Task 1 (`9bb8866`), Task 2 (`9156d13`), Task 3 (`f304e5d`), Task 4 (`a1eccea`), Task 5 (`76d1022`), Task 6 (`dd389a4`) shipped as specified, each independently re-verified line-by-line before commit. Task 1's implementation had a NUL-byte corruption bug caught and fixed pre-commit; Task 4's had a missing `supersedesImportId` wiring bug (would have broken every "Replace workbook" attempt) caught and fixed pre-commit; Task 5 caught and fixed a real data leak in `src/app/operations/b2c/page.tsx` (the server component was serializing full Admin-only Stripe evidence into every role's page payload, unused by the client -- stripped it).
- Task 6 replaced dead code rather than extending it: the pre-existing `manualBankTransferSchema`/`SupabaseB2cPaymentsRepository.createManualBankTransfer` let the browser supply currency/exchange-rate/gross/net/tax directly via a raw table insert -- exactly what the plan forbids. Nothing referenced either, so both were replaced outright with the plan's actual USD-only, server-derived shape and a protected RPC. The three-tier duplicate check (exact bank reference -> exact Finance source-identity, posted or unposted -> standard 48-hour content fingerprint) was hand-verified byte-for-byte against Task 1's existing identity formula and the existing content-fingerprint function; nothing was reinvented. pgTAP assertions were written but are unexecuted (no local Postgres in this environment) -- run `npm run supabase:test` for real once the migrations are applied.
- **Task 5 unblocks the Hoor Alshubbar fix.** The append-only posted-adjustment flow (`adjust-b2c-finance-payment.ts` + `/api/admin/b2c/payments/[paymentId]/finance-adjustments`) is now live in the drawer -- a `finance_tracker` payment always routes to it as the primary action, regardless of blocking reason. The RPC parameter contract was verified directly against the migration SQL, and the RPC's own expected-state re-validation was confirmed to make a stale/wrong client-side read fail-safe (rejected write, never a wrong one). The payment itself has not been corrected yet -- that's a live admin action, not a code change, and still waits on the reimport decision below.
- **Not in the original plan, added by direct request (`8f8969a`, `aec5e68`, `50f13fe`, `340b4ea`):** the Ledger's 6-column table gained customer email/mobile and provider description/seller-message display; an "implausible future business date" check was added at both the Payment Tracker ingestion layer and the general decision layer (so it catches new imports *and* already-posted payments); day/month date-parsing safety was audited end to end and locked in with regression tests.
- **Open finding, not yet resolved:** the only Payment Tracker import in the database (12 Aug 2026) predates the Task 1 lineage system by six days. Task 2's backfill only covered already-*posted* rows, so 1,002 of 1,163 valid staged rows have no lineage and no candidate — invisible to both Ledger and Work queue (86 iOS/bank-transfer rows, $6,839.52, genuinely should be reviewable; 916 other-method rows, $429,449.93, likely already captured via Stripe/Tap sync). **Decision: wipe and reimport all B2C source data from scratch** (Payment Tracker sheets, Stripe API, Tap), rather than backfill nine months of historical staging data. A live posted payment (Hoor Alshubbar, `85edf4fe-346b-483a-8053-199e6b1e2961`, $48.45) currently carries the wrong future date from this same gap and stays as-is until an Admin actually runs the correction through Task 5's now-live adjustment flow. Full detail and a post-reimport test-plan checklist live in the published "B2C Control Flow Review" artifact from this session (real figures, decision log, area-by-area checklist).
- Whoever picks this plan up next: re-run the reimport test-plan checklist before treating Tasks 1-4 as fully proven against real data, not just against the unit/integration suite.

## Global Constraints

- Stripe and Tap remain read-only. No task may create, update, refund, or delete provider records.
- Source payments, refunds, workbook rows, statements, and imported evidence remain immutable and traceable.
- Missing financial values are unavailable, never zero. Unknown FX never becomes an inferred USD value.
- Refunds remain separate linked events. A payment is never changed to a synthetic `refunded` decision state.
- Provider status, reconciliation status, reporting decision, and Finance-posting state remain separate domain facts.
- A clean succeeded Stripe/Tap payment is automatically reportable only when amount, business date, USD value, category, duplicate checks, and all other blocking rules pass.
- Missing source e-mail remains blocking until a verified correction, approved Finance Tracker provenance, or an explicit audited Finance exception exists.
- A Finance exception never bypasses failed/pending status, unknown amount/date, unresolved duplicate, unresolved blocking issue, or missing Finance-approved FX.
- Payment Tracker posting remains limited to Finance-approved `ios` and `bank_transfer` rows and never creates a Stripe, Tap, or Apple identity.
- Every manual financial action records the authenticated actor, timestamp, reason, before values, and after values.
- Every browser write uses a request-scoped authenticated Supabase client; the database remains the authorization and audit boundary.
- Existing direct URLs remain usable through redirects. Do not leave two live Admin surfaces for the same B2C action.
- Do not modify `old-project/`.
- Do not stage `tsconfig.tsbuildinfo`, `supabase/.temp/`, `.DS_Store`, credentials, or private source files.

## Explicit B2C v1 Scope

This plan intentionally excludes assignment/ownership, hardcoded employee names, exception expiry, chargebacks, period closing, reconciliation exports, and a universal sheet/API comparison matrix. Add those only through a later approved business-rule change.

The B2C workspace reports **cash received** and linked refunds. Do not rename those values to recognised revenue unless Finance approves a separate recognition rule.

## One Owner Per Workflow

| Responsibility | Sole owner | Explicitly not an owner |
|---|---|---|
| Prioritize exceptional B2C records | `Work queue` | Ledger, Review Queue, Administration, Sources |
| Decide or correct an existing B2C record | Shared record drawer, opened from Work queue or Ledger | Inline table/card controls, Review Queue, Administration, Sources |
| Inspect all payments, refunds, status, evidence, and audit history | `Ledger`, opening the same shared record drawer | Separate reconciliation or Finance pages |
| Sync providers, run backfills, upload evidence/workbooks, and inspect import history | `Sources` | Administration and Work queue |
| Enter a manual bank transfer | `Sources` through one reviewed Admin action | Administration and Ledger |
| Alert an Admin that B2C needs attention | Global `Review Queue`, deep-linking to the exact B2C work item | A second B2C mutation form |
| Manage non-B2C administration | `Administration` | B2C workspace |

These boundaries are acceptance criteria, not just navigation preferences. A live action must render in exactly one place. Reuse one service, validation contract, and API route per action; do not preserve aliases that can write the same financial fact through a second path. Redirect old human-facing page URLs, but delete unused legacy write APIs rather than maintaining two ingestion or mapping contracts.

## Three Payment-Entry Paths

| Payment path | How it enters PLAYBOOK | Resulting source | Admin action | Duplicate boundary |
|---|---|---|---|---|
| Finance-approved iOS already in Payment Tracker | Import or replace the workbook | `finance_tracker` with method `ios` | Resolve blockers, then use the one Ready-to-post action | Stable Finance lineage across workbook versions |
| Finance-approved bank transfer already in Payment Tracker | Import or replace the workbook | `finance_tracker` with method `bank_transfer` | Resolve blockers, then use the same Ready-to-post action | Stable Finance lineage across workbook versions |
| A genuinely new bank transfer not present in Payment Tracker | `Add bank transfer` in Sources | `manual_bank_transfer` | Review the entered facts and cross-source duplicate result, then confirm | Exact bank reference plus content comparison against all B2C payments and Payment Tracker lineages |

iOS is sheet-only in B2C v1: there is no `Add iOS payment` button and no invented Apple/provider identity. A sheet bank transfer is never re-entered manually. Manual bank entry is for new transfers, including new transfers received after the latest workbook, and must first check both posted and unposted Finance lineages. An exact existing payment/lineage match rejects creation and links the Admin to the existing record. A possible match may be retained only with an open `possible_duplicate` flag and remains outside totals until an audited decision.

Manual bank entry is USD-only in B2C v1. Require bank reference, customer name, customer e-mail, bank transfer date/time with an explicit offset, USD amount, category, and audit reason. PLAYBOOK derives the Bahrain business date and supplies `USD` and exchange rate `1` server-side. Foreign-currency bank transfers require an approved later rule and are not silently converted through this form.

## Final B2C UI Inventory

### Keep

- One sidebar link named `B2C`.
- One page with `Work queue`, `Ledger`, and `Sources` tabs stored in the URL.
- A compact page status showing coverage/data-as-of plus four values: reportable cash, linked refunds, net cash, and blockers. Do not keep a fifth competing source-total KPI in the header.
- One shared record drawer for source evidence, local values, the next safe action, and audit history.
- One Ready-to-post panel with counts split into iOS and bank transfer and one button: `Post N Finance payments`.
- One reviewed `Add bank transfer` flow in Sources.

### Move and simplify

- Move Stripe/Tap sync, backfill, and evidence uploads from Administration/Reconciliation into their corresponding Sources cards.
- Move Payment Tracker import/replacement into one Payment Tracker Sources card.
- Move staged Stripe contact evidence into the shared record drawer; do not keep a separate contact-review table.
- Move corrections, FX, mapping, Finance exceptions, duplicate choices, and posted adjustments into the shared drawer.
- Collapse the current always-visible reporting-reconciliation module into `Why totals differ`, a secondary disclosure in Ledger. The calculations remain; the large permanent card does not.
- Show only `Search`, `Source`, `Status`, and `Issue` as primary Ledger filters. Put date, amount, category, currency/FX, and evidence filters under `More filters`.
- Keep internal work-item types detailed, but group the visible Work queue into five filters: `All`, `Data`, `Duplicates`, `Reconciliation`, and `Ready to post`.

### Remove

- Separate B2C Operations, B2C Reconciliation, and B2C Finance navigation entries/pages as live workflows; keep only redirects for old page bookmarks.
- The fake Administration modules for bank transfer, correction, and product mapping.
- B2C Stripe/Tap sync and backfill controls from Administration after Sources owns them.
- The manual `Find exact duplicates` button. Exact cross-tab candidates are generated automatically during Payment Tracker finalization.
- Bulk Date acceptance. Every conflicting/implausible date is reviewed individually.
- Bulk duplicate-selection APIs and parallel duplicate-review components. One group, one reviewed choice, one canonical decision route.
- Separate `View Stripe evidence`, `Edit locally`, and refund-FX row buttons. Each Ledger/work item has one `Review` or specific next-action button that opens the shared drawer.
- The fourteen-column desktop ledger. Keep customer, date, amount, source, status, and next action; move all other facts into the drawer.
- The separate Stripe evidence dialog, staged Stripe contact table, repeated instructional cards, nested Ready-to-post cards, and page-level `How this operates` module.

### Button and module rules

- Viewer: Ledger is the default. Work queue and every write button are absent. Sources shows coverage/history only and no upload, sync, backfill, posting, or manual-entry controls.
- Admin Work queue: each item has one primary next action. Choice controls may appear inside the drawer, but only one final submit button is emphasized.
- Admin Ledger: rows open the same drawer; it has no independent mutation buttons outside that drawer.
- Stripe/Tap Sources card: show `Sync now` as the normal action; place rare `Backfill history` and evidence upload under `More actions`.
- Payment Tracker Sources card: show `Import workbook` when empty or `Replace workbook` when a completed import exists. After file selection show `Preview`; only after a successful preview replace it with `Import reviewed workbook` or `Replace with reviewed workbook`. Do not show two simultaneously disabled buttons.
- Manual bank transfer: show one `Add bank transfer` button. Step 1 collects required facts; server preview performs duplicate checks; Step 2 shows the exact values and match result; the final button is `Record bank transfer`.
- Duplicate review: show the two immutable source rows, allow one selection or group exclusion, require a reason, and expose one final `Record decision` button.
- Successful actions return the Admin to the same tab/filter and update counts in place. Failed actions keep the drawer/form and entered values visible, identify the field or conflict, and state that no data changed.

---

### Task 1: Prevent Payment Tracker rows from being reposted across workbook versions — ✅ Complete (9bb8866)

**Files:**
- Create: `src/lib/b2c/finance-source-identity.ts`
- Create: `src/server/services/b2c-finance-import-versioning.ts`
- Create: `supabase/migrations/20260818100000_b2c_finance_import_lineages.sql`
- Create: `src/lib/validation/b2c-finance-lineage-contracts.ts`
- Create: `src/app/api/admin/b2c/finance-imports/[importId]/lineage-decisions/route.ts`
- Delete: `src/app/api/admin/b2c/finance-imports/preview/route.ts`
- Delete: `src/app/api/admin/b2c/finance-imports/finalize/route.ts`
- Modify: `src/server/services/payment-tracker-upload.ts`
- Modify: `src/server/repositories/b2c-finance-reconciliation-repository.ts`
- Modify: `src/lib/validation/payment-tracker-upload-contracts.ts`
- Test: `tests/b2c-finance-source-identity.test.ts`
- Test: `tests/payment-tracker-upload-api.test.ts`
- Test: `tests/b2c-finance-lineage-api.test.ts`
- Create: `tests/b2c-finance-duplicate-decision-api.test.ts`
- Delete: `tests/b2c-finance-reconciliation-api.test.ts`
- Test: `tests/database-foundation.test.ts`
- Test: `supabase/tests/database_foundation.test.sql`
- Docs: `docs/DATABASE_SCHEMA.md`, `docs/DATABASE_RULES.md`, `docs/INTEGRATIONS.md`

**Interfaces:**
- Produces `createFinanceSourceIdentity(input): string` from normalized customer name, business date, USD amount, and normalized payment method. It deliberately excludes source tab and category because `B2C` and `B2C Cons` do not share equivalent category fields.
- Produces `FinanceImportCandidate = { candidateId, financeRowIds, sourceIdentity, priorLineageIds, priorPaymentIds, reason }`.
- Produces `FinanceImportRowMatch = { financeRowId, lineageId, sourceIdentity }`.
- Produces `FinanceImportDiff = { unchanged, newCandidates, removedCandidates, ambiguousCandidates, existingPaymentCandidates }`.
- Produces `previewFinanceImportVersion(input): FinanceImportDiff`.
- Produces `FinanceMethodSummary = { iosRows, bankTransferRows, unsupportedRows }` for preview and post-readiness copy; it is a count, never a financial total.
- Produces `FinanceLineageDecisionInput = { decision: "confirm_new" | "link_revision" | "link_existing_manual"; candidateId: string; targetLineageId?: string; targetPaymentId?: string; reason: string }`. Leaving a candidate unresolved performs no write.
- Adds `b2c_finance_record_lineages`, immutable `b2c_finance_row_lineage_links`, persisted `b2c_finance_import_version_candidates`, and append-only `b2c_finance_import_version_decisions`. Task 2 connects ledger posts to the stable lineage.
- Adds replacement-import provenance through `b2c_finance_imports.supersedes_import_id`.

- [x] **Step 1: Write identity and diff tests that demonstrate the current risk**

```ts
it("gives the same real payment the same identity across workbook hashes and tabs", () => {
  expect(createFinanceSourceIdentity({
    normalizedCustomerName: "maya al khalifa",
    occurredOn: "2026-08-01",
    amountUsd: "399.000000",
    normalizedPaymentMethod: "bank transfer",
  })).toBe(createFinanceSourceIdentity({
    normalizedCustomerName: "maya al khalifa",
    occurredOn: "2026-08-01",
    amountUsd: "399",
    normalizedPaymentMethod: "bank transfer",
  }));
});

it("classifies a row retained in a replacement workbook as unchanged", () => {
  expect(previewFinanceImportVersion({ previous: [priorRow], replacement: [samePaymentNewRow] }).unchanged).toHaveLength(1);
});

it("holds repeated same-key rows as ambiguous instead of merging them", () => {
  expect(previewFinanceImportVersion({ previous: [], replacement: [first, second, third] }).ambiguousCandidates).toHaveLength(3);
});

it("holds a later sheet bank row that matches a manual payment for explicit evidence linking", () => {
  expect(previewFinanceImportVersion({ previous: [], replacement: [sheetBankRow], representedPayments: [manualBankPayment] }).existingPaymentCandidates).toHaveLength(1);
});
```

- [x] **Step 2: Run the new tests and verify they fail**

Run: `npm test -- tests/b2c-finance-source-identity.test.ts tests/payment-tracker-upload-api.test.ts tests/database-foundation.test.ts`

Expected: FAIL because the identity, version diff, lineage tables, and replacement contract do not exist.

- [x] **Step 3: Implement the pure source-identity and version-diff functions**

```ts
export type FinanceSourceIdentityInput = {
  normalizedCustomerName: string;
  occurredOn: string;
  amountUsd: string;
  normalizedPaymentMethod: string;
};

export type FinanceImportDiff = {
  unchanged: FinanceImportRowMatch[];
  newCandidates: FinanceImportCandidate[];
  removedCandidates: FinanceImportCandidate[];
  ambiguousCandidates: FinanceImportCandidate[];
  existingPaymentCandidates: FinanceImportCandidate[];
};
```

Canonicalize decimals to six places and text with the existing Finance normalization rules before hashing. Never use staging UUID, file hash, tab, row number, or category as the business-payment identity.

- [x] **Step 4: Add lineage and import-version database constraints**

The migration must enforce:

```sql
alter table public.b2c_finance_imports
  add column supersedes_import_id uuid references public.b2c_finance_imports(id);

create table public.b2c_finance_record_lineages (
  id uuid primary key default gen_random_uuid(),
  source_identity char(64) not null,
  represented_payment_id uuid unique references public.b2c_payments(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.b2c_finance_row_lineage_links (
  finance_row_id uuid primary key references public.b2c_finance_staging_rows(id),
  lineage_id uuid not null references public.b2c_finance_record_lineages(id),
  link_kind text not null check (link_kind in ('initial', 'unchanged_version', 'admin_confirmed_new', 'admin_confirmed_revision', 'admin_linked_existing_manual')),
  linked_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.b2c_finance_import_version_candidates (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.b2c_finance_imports(id),
  candidate_kind text not null check (candidate_kind in ('new', 'removed', 'ambiguous', 'existing_payment')),
  source_identity char(64) not null,
  finance_row_ids uuid[] not null check (cardinality(finance_row_ids) > 0),
  prior_lineage_ids uuid[] not null default '{}',
  prior_payment_ids uuid[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  unique (import_id, candidate_kind, source_identity)
);

create table public.b2c_finance_import_version_decisions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.b2c_finance_imports(id),
  candidate_id uuid not null references public.b2c_finance_import_version_candidates(id),
  decision text not null check (decision in ('confirm_new', 'link_revision', 'link_existing_manual')),
  target_lineage_id uuid references public.b2c_finance_record_lineages(id),
  target_payment_id uuid references public.b2c_payments(id),
  reason text not null check (char_length(trim(reason)) between 3 and 1000),
  decided_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (import_id, candidate_id),
  check (
    (decision = 'confirm_new' and target_lineage_id is null and target_payment_id is null)
    or (decision = 'link_revision' and target_lineage_id is not null and target_payment_id is null)
    or (decision = 'link_existing_manual' and target_lineage_id is null and target_payment_id is not null)
  )
);
```

Add Admin-only insert/RPC access, approved-user safe reads where required, immutable-link/candidate triggers, actor attribution, indexes, and audit triggers. A represented payment must exist, use source `manual_bank_transfer`, and cannot be swapped or cleared. Finalization persists the safe diff candidates in the same transaction as the replacement import. A replacement import cannot link new, existing-payment, or ambiguous candidates automatically.

- [x] **Step 5: Make preview and finalization declare replacement intent**

The upload preview accepts an optional prior completed Payment Tracker import ID and returns safe counts only. Finalization requires the same `supersedesImportId` used for preview. If any prior Payment Tracker import exists, a new import without replacement intent is rejected.

For the first import only, an unambiguous one-row identity or exact `B2C`/`B2C Cons` pair receives a lineage automatically unless the identity is already reserved by a manual bank payment; the pair still requires its existing canonical duplicate decision before posting. In a replacement import, unchanged identities link to their prior lineage automatically, while genuinely new or ambiguous identities remain non-postable candidates until an Admin records `confirm_new`, `link_revision`, or `link_existing_manual`. Removed identities remain retained history and never delete or reverse a posted payment automatically.

A manual bank transfer creates a lineage identity reservation with `represented_payment_id`. If a later workbook contains that transfer, preview/finalization produces an existing-manual candidate rather than a new postable lineage. `link_existing_manual` attaches the immutable workbook row/evidence to that reserved lineage; the posting service treats it as already represented and never creates a second payment. Multiple rows/payments sharing the identity remain ambiguous and cannot auto-link.

Create exact cross-tab candidate groups as part of the protected finalization transaction. The Admin must not run a second discovery action or click `Find exact duplicates`. Repeated/ambiguous keys remain ungrouped work items and receive no automatic lineage or canonical row.

Preview must show separate row counts for normalized `ios`, normalized `bank_transfer`, and unsupported methods. It must state that only the first two can eventually post; importing still stages every accepted source row for audit.

Delete the older `/api/admin/b2c/finance-imports/preview` and `/finalize` JSON routes and their route test. They accept already-parsed rows and would create a second Finance ingestion contract that can bypass file hashing, private source storage, replacement intent, and lineage decisions. The `/api/admin/b2c/payment-tracker/*` routes are the only Payment Tracker intake path; shared pure assessment code may remain internal.

- [x] **Step 6: Add database assertions for version safety**

Assert that:

- two different file hashes containing one unchanged historical payment share one lineage;
- a lineage link cannot be updated or deleted;
- ambiguous repeated keys have no automatic confirmed lineage;
- a bank row matching an existing manual-payment identity cannot post as a new Finance payment;
- a later workbook may link to the existing manual payment without changing its amount, date, source system, or audit history;
- Viewers cannot create imports or lineage decisions;
- an Admin actor is recorded for every link or decision.

- [x] **Step 7: Implement the lineage-decision API**

Validate `FinanceLineageDecisionInput` with Zod. `confirm_new` creates a new lineage, `link_revision` links to the named existing lineage, and `link_existing_manual` links the workbook evidence to the named manual payment's reserved lineage while marking it already represented. An unresolved candidate has no decision row and no postable lineage, so it cannot post. The protected database function must lock the candidate and reject a second conflicting decision.

Move the surviving one-group canonical/exclusion route assertions out of the deleted legacy import-route test and into `b2c-finance-duplicate-decision-api.test.ts`. Cover Viewer denial, canonical-row membership, meaningful reason, concurrent/second-decision rejection, and immutable source rows.

- [x] **Step 8: Run focused verification**

Run: `npm test -- tests/b2c-finance-source-identity.test.ts tests/payment-tracker-upload-api.test.ts tests/b2c-finance-lineage-api.test.ts tests/b2c-finance-duplicate-decision-api.test.ts tests/database-foundation.test.ts`

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add src/lib/b2c/finance-source-identity.ts src/server/services/b2c-finance-import-versioning.ts src/lib/validation/b2c-finance-lineage-contracts.ts 'src/app/api/admin/b2c/finance-imports/[importId]/lineage-decisions/route.ts' src/app/api/admin/b2c/finance-imports/preview/route.ts src/app/api/admin/b2c/finance-imports/finalize/route.ts src/server/services/payment-tracker-upload.ts src/server/repositories/b2c-finance-reconciliation-repository.ts src/lib/validation/payment-tracker-upload-contracts.ts supabase/migrations/20260818100000_b2c_finance_import_lineages.sql tests/b2c-finance-source-identity.test.ts tests/payment-tracker-upload-api.test.ts tests/b2c-finance-lineage-api.test.ts tests/b2c-finance-duplicate-decision-api.test.ts tests/b2c-finance-reconciliation-api.test.ts tests/database-foundation.test.ts supabase/tests/database_foundation.test.sql docs/DATABASE_SCHEMA.md docs/DATABASE_RULES.md docs/INTEGRATIONS.md
git commit -m "fix(b2c): prevent cross-import Finance double posting"
```

---

### Task 2: Make Finance posting lineage-idempotent and treat revisions as adjustments — ✅ Complete (9156d13)

**Files:**
- Create: `supabase/migrations/20260818103000_b2c_finance_lineage_posting.sql`
- Modify: `src/server/services/b2c-finance-action-center.ts`
- Modify: `src/server/repositories/b2c-finance-action-repository.ts`
- Modify: `src/server/repositories/b2c-finance-ledger-repository.ts`
- Modify: `src/features/b2c/b2c-approved-finance-posting.tsx`
- Test: `tests/approved-finance-payment.test.ts`
- Test: `tests/approved-finance-payment-api.test.ts`
- Test: `tests/b2c-finance-action-center.test.ts`
- Test: `tests/database-foundation.test.ts`
- Test: `supabase/tests/database_foundation.test.sql`
- Docs: `docs/ARCHITECTURE.md`, `docs/INTEGRATIONS.md`, `docs/TESTING_STRATEGY.md`

**Interfaces:**
- `b2c_finance_ledger_posts.lineage_id` is non-null and unique.
- `post_approved_b2c_finance_payments()` inserts at most one payment for a confirmed lineage.
- A lineage with `represented_payment_id` is already represented by an existing manual bank payment and is never eligible for another insert.
- A replacement row linked as `admin_confirmed_revision` never creates a second payment. If the lineage is already posted, the existing append-only adjustment function is the only monetary/date change path.
- Produces `FinancePostingReadiness = { readyLineages, readyIosLineages, readyBankTransferLineages, alreadyPostedLineages, blockedRows, ambiguousRows }`.
- Produces `summarizeFinancePostingReadiness(rows): FinancePostingReadiness`.

- [x] **Step 1: Write failing cross-import posting tests**

```ts
it("counts a replacement-workbook row as already posted through its lineage", () => {
  expect(summarizeFinancePostingReadiness(rows)).toEqual({
    readyLineages: 0,
    readyIosLineages: 0,
    readyBankTransferLineages: 0,
    alreadyPostedLineages: 1,
    blockedRows: 0,
    ambiguousRows: 0,
  });
});
```

Add pgTAP setup with two completed imports, different hashes, two staging UUIDs, one lineage, and one existing ledger post. Calling the posting RPC must leave exactly one `finance_tracker` payment.

Add a second setup where a new manual bank transfer reserves an identity and a later workbook bank row is linked to it. Posting must leave exactly one `manual_bank_transfer` payment and zero new `finance_tracker` payments for that identity.

- [x] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/approved-finance-payment.test.ts tests/approved-finance-payment-api.test.ts tests/b2c-finance-action-center.test.ts tests/database-foundation.test.ts`

Expected: FAIL because posting is still staging-row-idempotent.

- [x] **Step 3: Replace staging-row-only posting identity with lineage identity**

The migration must:

- backfill one lineage for every existing posted Finance row;
- add `lineage_id` to `b2c_finance_ledger_posts`;
- make `lineage_id` unique and non-null after backfill;
- require a confirmed lineage before posting;
- treat a lineage with `represented_payment_id` as already represented and never change that payment's source system;
- continue requiring effective positive USD amount, date, category, supported payment method, and a resolved canonical cross-tab decision;
- return safe counts based on lineages, not raw source rows.
- return separate ready counts for iOS and bank-transfer lineages so the single posting panel explains exactly what will be created.

- [x] **Step 4: Route replacement revisions safely**

For an unposted lineage, an Admin-confirmed revision becomes the current candidate. For a posted lineage, the UI explains that amount/date differences require an append-only posted adjustment and never offers `Post as new`.

Keep one batch action rather than a per-row Post button plus a second global action. The Ready-to-post panel lists the eligible iOS and bank-transfer lineages, shows both counts, and exposes one `Post N Finance payments` button. A successful response reports posted/already-posted/blocked counts and refreshes the same queue.

- [x] **Step 5: Verify known-value behavior**

Run after applying migrations locally: `npm run supabase:test`

Expected: PASS, including one original import + one replacement import = one posted payment.

Run: `npm test -- tests/approved-finance-payment.test.ts tests/approved-finance-payment-api.test.ts tests/b2c-finance-action-center.test.ts tests/database-foundation.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/20260818103000_b2c_finance_lineage_posting.sql src/server/services/b2c-finance-action-center.ts src/server/repositories/b2c-finance-action-repository.ts src/server/repositories/b2c-finance-ledger-repository.ts src/features/b2c/b2c-approved-finance-posting.tsx tests/approved-finance-payment.test.ts tests/approved-finance-payment-api.test.ts tests/b2c-finance-action-center.test.ts tests/database-foundation.test.ts supabase/tests/database_foundation.test.sql docs/ARCHITECTURE.md docs/INTEGRATIONS.md docs/TESTING_STRATEGY.md
git commit -m "fix(b2c): post Finance payments by stable lineage"
```

---

### Task 3: Create one accurate B2C decision and work-item layer — ✅ Complete (f304e5d)

**Files:**
- Create: `src/lib/b2c/payment-decision.ts`
- Create: `src/server/services/b2c-work-items.ts`
- Create: `src/server/repositories/b2c-ledger-repository.ts`
- Create: `src/server/repositories/b2c-workspace-repository.ts`
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Create: `src/lib/validation/b2c-workspace-contracts.ts`
- Create: `src/app/api/b2c/workspace/route.ts`
- Test: `tests/b2c-payment-decision.test.ts`
- Test: `tests/b2c-work-items.test.ts`
- Test: `tests/b2c-workspace-api.test.ts`
- Modify: `tests/b2c-payment-reportability.test.ts`
- Docs: `docs/ARCHITECTURE.md`, `docs/PROJECT_STRUCTURE.md`, `docs/INTEGRATIONS.md`

**Interfaces:**

```ts
export type B2cPaymentDecision = {
  sourceStatus: "succeeded" | "failed" | "pending";
  reconciliationStatus: "not_required" | "matched" | "unmatched" | "mismatch" | "duplicate_pending";
  reportingDecision: "reportable" | "blocked" | "excluded" | "exception_included";
  postingStatus: "not_applicable" | "not_ready" | "ready" | "posted" | "adjusted";
  blockingReasons: B2cBlockingReason[];
  explanation: string;
};

export type B2cBlockingReason =
  | "missing_amount"
  | "missing_business_date"
  | "missing_customer_email"
  | "missing_fx"
  | "unmapped_category"
  | "possible_duplicate"
  | "failed_payment"
  | "pending_payment"
  | "unmatched_evidence"
  | "manual_exclusion"
  | "ambiguous_finance_lineage"
  | "other_open_review";

export type B2cWorkItem = {
  id: string;
  recordId: string;
  recordKind: "provider_payment" | "provider_refund" | "finance_row" | "provider_evidence" | "source_run";
  queue: "data_quality" | "duplicate" | "fx" | "mapping" | "reconciliation" | "ready_to_post" | "source_failure";
  visibleGroup: "data" | "duplicates" | "reconciliation" | "ready_to_post";
  financeMethod: "ios" | "bank_transfer" | null;
  title: string;
  explanation: string;
  financialImpactUsd: string | null;
  nextAction: "correct" | "map" | "convert_fx" | "choose_duplicate" | "compare" | "post" | "retry_source" | "review_exception" | "review_import_version";
  href: string;
};
```

- [x] **Step 1: Write decision tests for independent dimensions**

Cover succeeded USD mapped payment, missing e-mail without exception, missing e-mail with exception, failed payment, pending payment, missing business date, foreign currency with and without FX, unresolved duplicate, manual exclusion, approved Finance Tracker provenance, partial refund, and unmatched evidence.

Also cover an iOS tracker row, a bank-transfer tracker row, a new manual bank transfer, and a manual-bank candidate matching an existing tracker lineage. The first three retain distinct source/method labels; the matching manual candidate produces a duplicate-blocking work item rather than a second reportable payment.

The partial-refund assertion must keep `sourceStatus: "succeeded"`; the refund remains a linked row and does not replace the payment decision.

- [x] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/b2c-payment-decision.test.ts tests/b2c-work-items.test.ts tests/b2c-workspace-api.test.ts tests/b2c-payment-reportability.test.ts`

Expected: FAIL because the decision/work-item contracts and API do not exist.

- [x] **Step 3: Implement the decision mapper without changing approved reportability**

Use `b2cPaymentExclusionReasons()` as the initial financial gate. Do not make missing contact automatically reportable. Do not pass statement evidence through the payment gate.

- [x] **Step 4: Extract focused repository responsibilities**

Keep `b2c-dashboard-repository.ts` as a compatibility facade while moving:

- paged ledger reads to `b2c-ledger-repository.ts`;
- work-item aggregation to `b2c-workspace-repository.ts`;
- pure status mapping to `payment-decision.ts`;
- pure work-item prioritization to `b2c-work-items.ts`.

The new ledger query accepts server-side `cursor`, `limit` (maximum `100`), period, source, source status, reporting decision, issue, currency, amount range, sort, and search filters.

Keep detailed queue reasons in the domain model while deriving only four visible groups plus `All`. FX and mapping belong under `Data`; source failures and provider mismatches belong under `Reconciliation`. `Ready to post` is aggregated into the one Finance posting panel and does not generate one Post button per row.

- [x] **Step 5: Implement the authenticated read API**

Validate query parameters with Zod. Return safe viewer fields only. Admin-only source contacts or evidence must remain behind existing Admin authorization boundaries.

- [x] **Step 6: Run focused verification**

Run: `npm test -- tests/b2c-payment-decision.test.ts tests/b2c-work-items.test.ts tests/b2c-workspace-api.test.ts tests/b2c-payment-reportability.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit `0`.

Run: `npm run lint`

Expected: exit `0`.

- [x] **Step 7: Commit**

```bash
git add src/lib/b2c/payment-decision.ts src/server/services/b2c-work-items.ts src/server/repositories/b2c-ledger-repository.ts src/server/repositories/b2c-workspace-repository.ts src/lib/b2c/payment-reportability.ts src/server/repositories/b2c-dashboard-repository.ts src/lib/validation/b2c-workspace-contracts.ts src/app/api/b2c/workspace/route.ts tests/b2c-payment-decision.test.ts tests/b2c-work-items.test.ts tests/b2c-workspace-api.test.ts tests/b2c-payment-reportability.test.ts docs/ARCHITECTURE.md docs/PROJECT_STRUCTURE.md docs/INTEGRATIONS.md
git commit -m "feat(b2c): add one decision and work-item model"
```

---

### Task 4: Replace the three B2C front doors and duplicate Admin controls with one workspace — ✅ Complete (a1eccea)

**Files:**
- Create: `src/features/b2c/b2c-workspace.tsx`
- Create: `src/features/b2c/b2c-work-queue.tsx`
- Create: `src/features/b2c/b2c-source-management.tsx`
- Create: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Create: `src/features/b2c/b2c-payment-tracker-upload.tsx`
- Create: `src/features/b2c/b2c-tap-statement-upload.tsx`
- Create: `src/features/b2c/b2c-stripe-charges-upload.tsx`
- Create: `src/features/b2c/b2c-ledger-table.tsx`
- Modify: `src/features/b2c/b2c-operations.tsx`
- Modify: `src/features/b2c/b2c-ledger-filters.tsx`
- Modify: `src/app/operations/b2c/page.tsx`
- Modify: `src/app/operations/b2c/reconciliation/page.tsx`
- Modify: `src/app/admin/b2c-finance/page.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/features/admin/admin-page.tsx`
- Modify: `src/server/services/review-queue.ts`
- Test: `tests/b2c-workspace-ui.test.tsx`
- Test: `tests/b2c-ui-ownership.test.tsx`
- Modify: `tests/ui-system.test.tsx`
- Modify: `tests/review-queue-api.test.ts`
- Docs: `docs/UI_SYSTEM.md`, `docs/PROJECT_STRUCTURE.md`

**Interfaces:**
- `/operations/b2c?tab=work` is the Admin default.
- `/operations/b2c?tab=ledger` is the Viewer default and the all-record inspection view.
- `/operations/b2c?tab=sources` owns provider sync, upload, coverage, and import history.
- `/operations/b2c/reconciliation` redirects to `/operations/b2c?tab=sources`.
- `/admin/b2c-finance` redirects to `/operations/b2c?tab=work&queue=ready_to_post`.
- Review Queue B2C items link to the corresponding B2C work item and do not expose a second mutation surface.
- Administration contains no B2C correction, mapping, manual-payment, Stripe, or Tap controls. It retains HubSpot and genuinely cross-product administration only.
- Admins see all three tabs. Viewers default to Ledger, cannot open Work queue, and see Sources as read-only coverage/import history without any action controls.

- [x] **Step 1: Write navigation and workspace tests**

```tsx
expect(screen.getByRole("link", { name: "B2C" })).toBeInTheDocument();
expect(screen.queryByRole("link", { name: "B2C reconciliation" })).not.toBeInTheDocument();
expect(screen.queryByRole("link", { name: "B2C Finance" })).not.toBeInTheDocument();
```

Test Admin and Viewer defaults, URL-preserved tab/queue selection, redirects, queue-specific empty states, one primary action per work item, and B2C Review Queue deep links. Assert each B2C sync, upload, correction, and mapping action appears once across the B2C and Administration renders. Assert there is no `Add iOS payment`, `Find exact duplicates`, bulk Date-acceptance, second Post button, separate evidence button, or Viewer write button.

- [x] **Step 2: Run UI tests and verify failure**

Run: `npm test -- tests/b2c-workspace-ui.test.tsx tests/b2c-ui-ownership.test.tsx tests/ui-system.test.tsx tests/review-queue-api.test.ts`

Expected: FAIL because the unified workspace and redirects do not exist.

- [x] **Step 3: Build the workspace shell**

The page header shows selected period and a compact coverage/data-as-of status, then exactly four values: reportable cash, linked refunds, net cash, and blocker count. Move completed-source totals into `Why totals differ`; do not compete with the four operational values. Internal tabs are keyboard accessible and stored in the query string.

The Work queue uses five filter chips: `All`, `Data`, `Duplicates`, `Reconciliation`, and `Ready to post`. These are filters within one tab, not pages. `Data` includes corrections, Date checks, FX, and mappings; `Reconciliation` includes import-version decisions, evidence mismatches, and source failures.

Build Sources as four compact cards: Stripe, Tap, Payment Tracker, and Manual bank transfers. Stripe/Tap show status and last success, `Sync now`, and a `More actions` disclosure for backfill and evidence upload. Payment Tracker shows latest import/version state and one context-aware `Import workbook` or `Replace workbook` action. Manual bank transfers shows `Add bank transfer` and recent audited entries after Task 6. Extract the current upload controls into the three focused components and move Stripe/Tap sync/backfill from Administration without changing financial behavior in this task.

Each upload component is a state machine rather than two permanently visible buttons: select file, `Preview`, review safe counts, then `Import reviewed…`/`Replace with reviewed…`; `Change file` is secondary. Reserve preview/result space so loading does not shift the page, and show progress while every async action runs.

Create the shared drawer shell with accessible open/close, focus return, summary fields, and a slot for the current action component. Work queue and Ledger must both open this same shell; Task 5 completes its evidence, audit, and action consolidation without introducing another modal.

- [x] **Step 4: Make the ledger responsive and paged**

Desktop columns are limited to customer, date, amount, source, work/Finance status, and next action. Provider IDs, phone/e-mail, source currency, plan, evidence, and audit details move into the detail drawer. Mobile uses compact record cards rather than a fourteen-column table.

Show Search, Source, Status, and Issue first. Put date range, amount range, category, currency/FX, and evidence filters in `More filters`; preserve active advanced filters through an applied-count badge. Put the existing completed/excluded/reportable/refund calculation bridge in a collapsed `Why totals differ` disclosure below the four summary values.

- [x] **Step 5: Remove duplicate navigation surfaces**

Rename the sidebar entry to `B2C`, remove the separate B2C Reconciliation and B2C Finance links, and implement server redirects at their existing routes. Do not delete route files while bookmarks still exist.

Remove the nonfunctional `Bank transfer entry`, `Correct a record`, and `Product mapping` previews from Administration. Remove Stripe/Tap sync and backfill controls there after Sources renders the same live controls. Keep HubSpot controls in Administration. At the end of this task, no B2C action may appear on two pages, even temporarily.

Do not carry the staged Stripe contact table or `How this operates` card into the workspace. Evidence belongs in the drawer, and short contextual help belongs beside the action it explains. Keep one Ready-to-post container; do not nest the existing posting section inside another posting card.

- [x] **Step 6: Run responsive and interaction verification**

Run: `npm test -- tests/b2c-workspace-ui.test.tsx tests/b2c-ui-ownership.test.tsx tests/ui-system.test.tsx tests/review-queue-api.test.ts`

Expected: PASS.

Use Playwright at `375`, `768`, `1024`, and `1440` CSS pixels. Verify no page-level horizontal overflow, visible focus, predictable back behavior, at least `44px` interactive targets, stable loading space, one primary action per state, and no write controls for Viewers.

- [x] **Step 7: Commit**

```bash
git add src/features/b2c/b2c-workspace.tsx src/features/b2c/b2c-work-queue.tsx src/features/b2c/b2c-source-management.tsx src/features/b2c/b2c-payment-review-drawer.tsx src/features/b2c/b2c-payment-tracker-upload.tsx src/features/b2c/b2c-tap-statement-upload.tsx src/features/b2c/b2c-stripe-charges-upload.tsx src/features/b2c/b2c-ledger-table.tsx src/features/b2c/b2c-operations.tsx src/features/b2c/b2c-ledger-filters.tsx src/app/operations/b2c/page.tsx src/app/operations/b2c/reconciliation/page.tsx src/app/admin/b2c-finance/page.tsx src/components/app-shell.tsx src/features/admin/admin-page.tsx src/server/services/review-queue.ts tests/b2c-workspace-ui.test.tsx tests/b2c-ui-ownership.test.tsx tests/ui-system.test.tsx tests/review-queue-api.test.ts docs/UI_SYSTEM.md docs/PROJECT_STRUCTURE.md
git commit -m "feat(b2c): consolidate Admin work into one workspace"
```

---

### Task 5: Consolidate payment review into one accessible detail drawer — ✅ Complete (76d1022)

**Files:**
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Create: `src/features/b2c/b2c-source-evidence-panel.tsx`
- Create: `src/features/b2c/b2c-audit-timeline.tsx`
- Create: `src/server/services/adjust-b2c-finance-payment.ts`
- Create: `src/lib/validation/b2c-posted-adjustment-contracts.ts`
- Create: `src/app/api/admin/b2c/payments/[paymentId]/finance-adjustments/route.ts`
- Modify: `src/features/b2c/b2c-payment-review-actions.tsx`
- Delete after moving its behavior: `src/features/b2c/b2c-stripe-evidence-dialog.tsx`
- Modify: `src/features/b2c/b2c-refund-fx-review-actions.tsx`
- Delete: `src/app/api/admin/b2c/stripe-products/map/route.ts`
- Modify: `src/app/api/admin/b2c/finance-actions/date-authority/route.ts`
- Modify: `src/lib/validation/b2c-finance-action-contracts.ts`
- Test: `tests/b2c-payment-review-drawer.test.tsx`
- Create: `tests/b2c-payment-duplicate-drawer.test.tsx`
- Create: `tests/b2c-posted-finance-adjustment-api.test.ts`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- Delete after moving assertions: `tests/b2c-exact-duplicate-reconciliation-ui.test.tsx`

**Interfaces:**
- Drawer sections: `Summary`, `Source evidence`, `Local values`, `Finance decision`, `Audit history`.
- The work-item `nextAction` selects one visible primary action.
- Secondary actions appear under `More actions`; source evidence is never editable.
- A successful action keeps the Admin in the same queue and removes the item only after server confirmation.
- `PostedFinanceAdjustmentRequest = { expectedOccurredOn, expectedAmountUsd, verifiedOccurredOn?, verifiedAmountUsd?, reason }`; the browser never sends signed adjustment rows.

- [x] **Step 1: Write failing drawer behavior tests**

Test Admin/Viewer rendering, focus entry and return, Escape close, contained scrolling, source/local visual separation, one primary action, error retention, and queue refresh only after success. Test that Ledger/work-item rows expose one drawer action instead of separate evidence, edit, and refund-FX triggers.

- [x] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/b2c-payment-review-drawer.test.tsx tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-posted-finance-adjustment-api.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: FAIL because review behavior is spread across separate modal/dialog components.

- [x] **Step 3: Move existing actions without changing their financial rules**

Reuse the existing routes for local correction, product mapping, FX, Finance exception, refund FX, and duplicate decisions. Do not duplicate validation in the drawer. Show inline field errors near the affected input and preserve the draft on failure.

Use `/api/admin/b2c/products/map` as the sole provider-product mapping route. Delete the unused Stripe-only `/api/admin/b2c/stripe-products/map` route; it overlaps the generic mapping contract and database operation. Move Stripe evidence into the shared evidence panel, then delete the separate Stripe evidence dialog once imports are zero.

Convert `b2c-payment-review-actions.tsx` and `b2c-refund-fx-review-actions.tsx` into action-content fragments with no trigger button, backdrop, or dialog ownership. The shared drawer owns opening, closing, focus, errors, refresh, and audit context. Duplicate work items use only `/api/admin/b2c/reconciliation/[groupId]/decision`; show both immutable rows, one selection/exclusion choice, one reason, and one `Record decision` submit.

Move Finance Tracker Date/detail correction into the same drawer. The Date-authority route accepts exactly one reviewed row per request; remove the current bulk Date button behavior. For a posted Finance payment, the drawer calls the new adjustment service/route, which validates expected current amount/date and invokes the existing append-only database RPC. Show the calculated effect before confirmation; never expose signed adjustment construction to the browser.

- [x] **Step 4: Make exception wording and behavior exact**

The exception action requires the exact provider ID confirmation, no-known-duplicate confirmation, verified category, effective amount/date, and reason. Closing or dismissing a review flag alone must not make the payment reportable.

- [x] **Step 5: Run focused verification**

Run: `npm test -- tests/b2c-payment-review-drawer.test.tsx tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-posted-finance-adjustment-api.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-review-contracts.test.ts`

Expected: PASS.

Run: `npm run typecheck && npm run lint`

Expected: both exit `0`.

- [x] **Step 6: Commit**

```bash
git add src/features/b2c/b2c-payment-review-drawer.tsx src/features/b2c/b2c-source-evidence-panel.tsx src/features/b2c/b2c-audit-timeline.tsx src/server/services/adjust-b2c-finance-payment.ts src/lib/validation/b2c-posted-adjustment-contracts.ts 'src/app/api/admin/b2c/payments/[paymentId]/finance-adjustments/route.ts' src/features/b2c/b2c-payment-review-actions.tsx src/features/b2c/b2c-stripe-evidence-dialog.tsx src/features/b2c/b2c-refund-fx-review-actions.tsx src/app/api/admin/b2c/finance-actions/date-authority/route.ts src/lib/validation/b2c-finance-action-contracts.ts src/app/api/admin/b2c/stripe-products/map/route.ts tests/b2c-payment-review-drawer.test.tsx tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-posted-finance-adjustment-api.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-exact-duplicate-reconciliation-ui.test.tsx
git commit -m "feat(b2c): unify record review in one drawer"
```

---

### Task 6: Finish source management and live manual bank-transfer entry — ✅ Complete (dd389a4)

**Files:**
- Create: `src/server/services/b2c-provider-evidence-reconciliation.ts`
- Create: `supabase/migrations/20260818110000_b2c_provider_evidence_links.sql`
- Create: `supabase/migrations/20260818113000_b2c_manual_bank_transfer_entry.sql`
- Create: `src/features/b2c/b2c-manual-bank-transfer.tsx`
- Create: `src/server/services/record-manual-bank-transfer.ts`
- Create: `src/app/api/admin/b2c/payments/manual-bank-transfer/preview/route.ts`
- Create: `src/app/api/admin/b2c/payments/manual-bank-transfer/route.ts`
- Modify: `src/lib/validation/financial-contracts.ts`
- Modify: `src/server/repositories/b2c-payments-repository.ts`
- Modify: `src/features/b2c/b2c-source-management.tsx`
- Modify: `src/features/b2c/b2c-tap-statement-upload.tsx`
- Modify: `src/features/b2c/b2c-stripe-charges-upload.tsx`
- Create: `tests/b2c-manual-bank-transfer.test.ts`
- Create: `tests/b2c-manual-bank-transfer-api.test.ts`
- Create: `tests/b2c-manual-bank-transfer-ui.test.tsx`
- Create: `tests/b2c-provider-evidence-reconciliation.test.ts`
- Modify: `tests/database-foundation.test.ts`
- Modify: `supabase/tests/database_foundation.test.sql`
- Modify: `tests/payment-tracker-upload-api.test.ts`
- Modify: `tests/tap-statement-upload-api.test.ts`
- Modify: `tests/stripe-charges-upload-api.test.ts`
- Docs: `docs/BUSINESS_RULES.md`, `docs/INTEGRATIONS.md`, `docs/TESTING_STRATEGY.md`

**Interfaces:**
- Produces `reconcileProviderEvidence(input): { exactMatches, mismatches, unmatchedEvidence }` for Stripe Charges to Stripe API and Tap statement sales to Tap API. Provider transaction ID is the only automatic link key; amount, currency, date, and status are comparison facts.
- Adds immutable `b2c_provider_evidence_payment_links` with unique evidence ID, linked local payment ID, match state, actor/run provenance, and timestamps.
- Produces `recordManualBankTransfer(input, repository): Promise<B2cPayment>`.
- Produces `ManualBankTransferRequest = { bankReference, customerEmail, customerName, categoryCode, membershipTier?, amountUsd, receivedAt, reason }`, where `receivedAt` is an ISO timestamp with an explicit offset.
- Produces `ManualBankTransferDuplicateAssessment = { inputSha256, matchState: "clear" | "exact_existing" | "possible_duplicate"; exactMatchHref: string | null; possibleMatches: Array<{ recordKind, recordId, sourceLabel, occurredOn, amountUsd }> }`.
- Produces `previewManualBankTransfer(input, repository): Promise<ManualBankTransferDuplicateAssessment>`.
- Manual bank transfers require a unique bank/reference ID, customer name, customer e-mail, verified USD amount, bank transfer timestamp, category, and reason. B2C v1 manual bank transfers are USD-only; the server derives `occurred_on` in `Asia/Bahrain` and stores original currency `USD`, exchange rate `1`, succeeded status, source system, actor, and fingerprint rather than accepting them from the browser.
- The service calculates the duplicate fingerprint; the browser never supplies it.
- Exact bank-reference duplication is rejected. An exact Finance source-identity match against a posted or unposted `bank_transfer` lineage is also rejected and returns the existing record/work-item link; the sheet entry remains the sole payment path.
- The standard content check compares the candidate with all B2C payments using normalized e-mail + amount + category + business date over the approved 48-hour window. A Finance-specific comparison also checks normalized customer name + amount + business date + `bank_transfer` against confirmed and unresolved Payment Tracker lineages because tracker category/contact fields are not equivalent across tabs.
- A possible, non-exact match atomically creates the retained manual payment and an open `possible_duplicate` flag, so it remains excluded until an audited decision. A clear candidate creates one reportable `manual_bank_transfer` payment. Confirmation re-hashes the reviewed input and reruns every check inside the protected database transaction.
- The same transaction creates a Finance-compatible source-identity reservation linked through `represented_payment_id`, so a future Payment Tracker version recognizes this manual payment and cannot repost it.

- [x] **Step 1: Write failing manual-entry tests**

```ts
it("rejects a reused bank reference", async () => {
  repository.assessManualBankTransferDuplicates.mockResolvedValue(exactReferenceMatch);
  await expect(recordManualBankTransfer(input, repository)).rejects.toThrow("already exists");
});

it("rejects a new manual row that is already an unposted tracker lineage", async () => {
  repository.assessManualBankTransferDuplicates.mockResolvedValue(unpostedTrackerMatch);
  await expect(recordManualBankTransfer(input, repository)).rejects.toThrow("Payment Tracker");
});
```

Also test a posted tracker-lineage match, a clean new transfer received after the latest workbook, a possible 48-hour match, server-owned USD values/fingerprint, changed input after preview, and two concurrent confirmations for the same reference.

- [x] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/b2c-manual-bank-transfer.test.ts tests/b2c-manual-bank-transfer-api.test.ts tests/b2c-manual-bank-transfer-ui.test.tsx`

Expected: FAIL because the live service, route, and workspace action do not exist.

- [x] **Step 3: Implement the server-owned duplicate checks and write**

Extend the repository with:

```ts
assessManualBankTransferDuplicates(input: PreparedManualBankTransfer): Promise<ManualBankTransferDuplicateAssessment>;
createManualBankTransferAtomically(input: PreparedManualBankTransfer & { expectedInputSha256: string }): Promise<B2cPayment>;
```

Require `bankReference`, `customerName`, and `customerEmail` in the live request contract and keep decimal values as strings. The preview route performs read-only safe matching and returns no private source row. The final route uses one protected Admin-only database RPC to lock/check the reference, recheck payment fingerprints and Finance lineages, verify the reviewed-input hash, insert at most one retained payment, create its Finance-compatible identity reservation, add a `possible_duplicate` flag when required, and record actor/audit history atomically.

Do not reuse the current direct table-insert repository implementation. The browser may not send `sourceSystem`, status, original currency, exchange rate, gross/net/tax amounts, duplicate fingerprint, actor, or reportability. Remove those fields from the public manual-bank request contract.

- [x] **Step 4: Add the one manual bank-transfer workflow**

Place one `Add bank transfer` button in Sources and no `Add iOS payment` control anywhere. Step 1 collects the seven required facts plus optional membership tier, including the bank's transfer date and time rather than inventing a timestamp from a date. Submitting Step 1 calls preview and advances only after the server returns its duplicate assessment. Step 2 shows the exact amount/timestamp/derived business date/category/customer/reference/reason and one of: `No existing match`, `Existing Payment Tracker/payment found` with a link and no submit, or `Possible duplicate` with an explicit blocked-from-totals warning. The only final action is `Record bank transfer`; `Back` preserves the draft. Assert the B2C preview forms removed from Administration remain absent.

- [x] **Step 5: Add exact provider-evidence matching to the existing Sources controls**

Preserve the existing focused upload components, hash confirmation, private Storage cleanup, safe counts, evidence-only language, and Admin-only controls. Show period/date coverage and latest successful import for each source where the source provides it.

After a Stripe Charges or Tap statement import completes, run exact provider-ID reconciliation against the corresponding local API payment. Persist only exact links. A same-ID amount, currency, date, or status difference becomes a work-queue mismatch; evidence with no local API payment remains unmatched. Payment Tracker rows have no provider transaction ID and must never be automatically linked through name/amount guessing.

- [x] **Step 6: Add provider-evidence reconciliation tests**

Cover exact Stripe/Tap ID matches, repeated evidence idempotency, amount mismatch, currency mismatch, date mismatch, status mismatch, unmatched evidence, Viewer read-only access, and the rule that no evidence link creates a B2C payment or changes a financial total.

For manual entry, cover required fields, USD-only server values, no iOS entry action, exact reference rejection, posted/unposted Tracker-lineage rejection, existing provider/manual-payment rejection, possible-match retention with a blocking flag, clean new entry, identity-reservation creation, later-workbook recognition of the reserved identity, stale-preview rejection, concurrent confirmation idempotency, actor/reason audit, and Viewer denial at route and database layers.

- [x] **Step 7: Run focused verification**

Run: `npm test -- tests/b2c-manual-bank-transfer.test.ts tests/b2c-manual-bank-transfer-api.test.ts tests/b2c-manual-bank-transfer-ui.test.tsx tests/b2c-provider-evidence-reconciliation.test.ts tests/payment-tracker-upload-api.test.ts tests/tap-statement-upload-api.test.ts tests/stripe-charges-upload-api.test.ts tests/database-foundation.test.ts`

Expected: PASS.

Run: `npm run supabase:test`

Expected: PASS, including exact Tracker-lineage rejection and concurrent manual-reference protection.

Run: `npm run typecheck`

Expected: exit `0`.

Run: `npm run lint`

Expected: exit `0`.

- [x] **Step 8: Commit**

```bash
git add src/server/services/b2c-provider-evidence-reconciliation.ts supabase/migrations/20260818110000_b2c_provider_evidence_links.sql supabase/migrations/20260818113000_b2c_manual_bank_transfer_entry.sql src/features/b2c/b2c-tap-statement-upload.tsx src/features/b2c/b2c-stripe-charges-upload.tsx src/features/b2c/b2c-manual-bank-transfer.tsx src/server/services/record-manual-bank-transfer.ts src/app/api/admin/b2c/payments/manual-bank-transfer/preview/route.ts src/app/api/admin/b2c/payments/manual-bank-transfer/route.ts src/lib/validation/financial-contracts.ts src/server/repositories/b2c-payments-repository.ts src/features/b2c/b2c-source-management.tsx tests/b2c-manual-bank-transfer.test.ts tests/b2c-manual-bank-transfer-api.test.ts tests/b2c-manual-bank-transfer-ui.test.tsx tests/b2c-provider-evidence-reconciliation.test.ts tests/payment-tracker-upload-api.test.ts tests/tap-statement-upload-api.test.ts tests/stripe-charges-upload-api.test.ts tests/database-foundation.test.ts supabase/tests/database_foundation.test.sql docs/BUSINESS_RULES.md docs/INTEGRATIONS.md docs/TESTING_STRATEGY.md
git commit -m "feat(b2c): finish source intake and bank transfers"
```

---

### Task 7: Prove the complete B2C workflow and remove superseded UI code — ⬜ Not started

**Files:**
- Create: `tests/e2e/b2c-workspace-flow.spec.ts`
- Modify: `tests/database-foundation.test.ts`
- Modify: `supabase/tests/database_foundation.test.sql`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATABASE_SCHEMA.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/INTEGRATIONS.md`
- Delete after confirming import references are zero: `src/features/b2c/b2c-reconciliation-page.tsx`
- Delete after confirming import references are zero: `src/features/b2c/b2c-finance-action-module.tsx`
- Delete after confirming import references are zero: `src/features/b2c/b2c-finance-data-quality-actions.tsx`
- Delete after confirming import references are zero: `src/features/b2c/b2c-finance-duplicate-actions.tsx`
- Delete after confirming import references are zero: `src/features/b2c/b2c-exact-duplicate-review.tsx`
- Delete after confirming import references are zero: `src/server/services/b2c-exact-duplicate-review.ts`
- Delete: `src/app/api/admin/b2c/finance-actions/duplicates/bulk-canonical/route.ts`
- Delete: `src/app/api/admin/b2c/finance-actions/duplicates/selected/route.ts`
- Delete: `src/app/api/admin/b2c/reconciliation/exact-duplicates/group/route.ts`
- Delete: `src/app/api/admin/b2c/reconciliation/exact-duplicates/route.ts`
- Modify after removing obsolete cases: `tests/b2c-finance-action-api.test.ts`
- Delete after moving finalization/read coverage: `tests/b2c-exact-duplicate-reconciliation-api.test.ts`
- Delete after replacing coverage: `tests/b2c-finance-reconciliation-ui.test.tsx`
- Delete after replacing coverage: `tests/b2c-finance-action-ui.test.tsx`

**Interfaces:**
- The E2E workflow uses one B2C route and its query-string tabs/queues.
- All financial totals use the existing shared reportability and effective-ledger rules; the UI never calculates an independent total.

- [ ] **Step 1: Write the end-to-end acceptance tests**

Positive flow:

1. Load Stripe/Tap source records.
2. Import a Payment Tracker snapshot containing one iOS and one bank-transfer lineage; verify exact cross-tab candidates appear automatically without a Find button.
3. Import a different-hash replacement containing unchanged historical rows.
4. Verify unchanged rows cannot post twice.
5. Resolve one cross-tab duplicate.
6. Correct one missing field.
7. Approve one FX conversion.
8. Record one valid Finance exception.
9. Verify Ready to post shows separate iOS/bank counts and one batch Post button, then post eligible Finance lineages.
10. Add one genuinely new manual bank transfer through preview and confirmation.
11. Attempt a manual bank transfer that matches the sheet bank lineage and verify creation is rejected with a link to the existing record.
12. Import a later workbook containing the previously manual transfer, link its evidence to the existing manual payment, and verify posting creates nothing new.
13. Refresh and verify totals, statuses, source evidence, and audit history.

Negative flow:

1. A failed payment remains excluded.
2. A pending payment remains excluded.
3. Missing e-mail without an exception remains excluded.
4. An unresolved duplicate remains excluded.
5. Missing FX remains excluded.
6. Unmatched Tap statement evidence never becomes a payment.
7. An ambiguous replacement-workbook row cannot post.
8. There is no manual iOS entry action.
9. A Viewer has no Work queue or B2C write buttons.

- [ ] **Step 2: Add known-value financial assertions**

Use a small dataset whose totals are calculated in the test description:

- succeeded clean payment: `100.00`;
- partial refund: `25.00`;
- Finance Tracker payment appearing in two workbook versions: `40.00` counted once;
- manual bank transfer: `60.00`;
- failed/pending/ambiguous rows: `0.00` contribution;
- expected net cash: `175.00`.

- [ ] **Step 3: Remove superseded components and duplicate tests safely**

Run `rg` for each listed component/service before deletion. Delete it only after its behavior is present in the workspace/drawer and its imports are zero. Remove the two old page-level UI test files after their behavioral assertions exist in workspace/drawer tests; do not maintain the same workflow through parallel test harnesses. Keep route redirect files.

Delete the bulk-canonical, selected-duplicate, manual exact-grouping, and separate duplicate-list API routes after the workspace API supplies duplicate work items and Payment Tracker finalization creates groups automatically. Keep `/api/admin/b2c/reconciliation/[groupId]/decision` as the sole duplicate write route. Remove obsolete duplicate-route test cases while retaining Admin authorization and one-group decision coverage.

Run a final ownership audit with `rg`: the Payment Tracker has one preview/finalize route pair; provider mapping and duplicate decisions each have one write route; each Stripe/Tap sync, backfill, and upload control is rendered only from Sources; each correction, FX, duplicate, exception, and posted adjustment is reachable only through the shared drawer; the Ready-to-post queue has one batch Post action; manual entry has one Sources action; no iOS-entry action exists; Administration contains no B2C controls.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run supabase:test
```

Expected: every command exits `0`; Vitest and pgTAP report zero failures.

Run Playwright acceptance at `375`, `768`, `1024`, and `1440` widths. Verify the Work queue, Ledger, Sources, record drawer, manual bank transfer, replacement import, and Viewer read-only behavior.

- [ ] **Step 5: Reconcile one real approved month before release**

Finance supplies the approved source totals. Compare:

- Stripe API payment/refund counts;
- Tap API payment/refund counts;
- Stripe Charges and Tap statement evidence match/unmatched counts;
- unique Finance Tracker lineages, canonical duplicates, and posted lineages;
- reportable payments, linked refunds, and net B2C cash.

Record only counts and approved totals in the validation note. Do not commit customer data, raw provider IDs, source files, or credentials.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/b2c-workspace-flow.spec.ts tests/b2c-finance-reconciliation-ui.test.tsx tests/b2c-finance-action-ui.test.tsx tests/b2c-finance-action-api.test.ts tests/b2c-exact-duplicate-reconciliation-api.test.ts tests/database-foundation.test.ts supabase/tests/database_foundation.test.sql docs/ARCHITECTURE.md docs/DATABASE_SCHEMA.md docs/PROJECT_STRUCTURE.md docs/TESTING_STRATEGY.md docs/INTEGRATIONS.md src/features/b2c/b2c-reconciliation-page.tsx src/features/b2c/b2c-finance-action-module.tsx src/features/b2c/b2c-finance-data-quality-actions.tsx src/features/b2c/b2c-finance-duplicate-actions.tsx src/features/b2c/b2c-exact-duplicate-review.tsx src/server/services/b2c-exact-duplicate-review.ts src/app/api/admin/b2c/finance-actions/duplicates/bulk-canonical/route.ts src/app/api/admin/b2c/finance-actions/duplicates/selected/route.ts src/app/api/admin/b2c/reconciliation/exact-duplicates/group/route.ts src/app/api/admin/b2c/reconciliation/exact-duplicates/route.ts
git commit -m "test(b2c): verify the complete single-workspace flow"
```

---

## Final Admin Experience

1. The Admin opens **B2C** and lands in the Work queue.
2. Clean provider payments require no manual approval and appear in reportable cash automatically.
3. Every exceptional item explains what is wrong, its financial consequence, and the next safe action.
4. The Admin completes the action in one drawer and remains in the same queue.
5. The Ledger contains every payment and refund with source/local/audit distinctions.
6. Sources contains sync, backfill, uploads, coverage, and import history.
7. Payment Tracker preview separates iOS and bank-transfer rows; exact cross-tab candidates are generated without an extra button.
8. Replacement Payment Tracker files cannot repost unchanged historical payments.
9. Only confirmed unique iOS/bank-transfer Finance lineages can enter the B2C ledger through one batch action.
10. `Add bank transfer` records genuinely new USD transfers only; exact sheet/payment matches are rejected and possible matches stay blocked.
11. There is no manual iOS path and no second bank-entry form.
12. No source evidence disappears, no missing value becomes zero, and no provider is modified.

## B2C Completion Standard

B2C is complete only when:

- one sidebar destination reaches every B2C Admin workflow;
- the separate B2C Reconciliation and B2C Finance routes redirect into that workspace;
- two different workbook hashes containing the same payment cannot create two ledger payments;
- clean provider rows are automatic while exceptional rows remain explicitly reviewed;
- missing e-mail requires correction, approved Finance provenance, or a documented exception;
- refunds, FX, corrections, exclusions, and adjustments remain append-only and audited;
- manual bank-transfer entry is live and server-authorized;
- manual bank entry checks exact references, all B2C payment fingerprints, and posted/unposted Payment Tracker bank lineages before creation;
- iOS remains Payment Tracker-only, and imported sheet bank transfers are never manually re-entered;
- every B2C action/button appears in exactly one owning module, with no parallel dialog, bulk shortcut, or legacy write API;
- Viewer B2C rendering contains no Work queue or write controls;
- Viewer access is read-only at the server and database layers;
- one known month reconciles to approved source counts and totals;
- Vitest, TypeScript, ESLint, production build, pgTAP, and B2C Playwright acceptance all pass.
