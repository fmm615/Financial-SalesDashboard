# B2C Payment Review Drawer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the B2C drawer's single-primary-action layout with one visible, progressively disclosed card for every unresolved blocking reason.

**Architecture:** Keep the database-authoritative `B2cPaymentDecision` unchanged and map its canonical `blockingReasons` order directly to presentational cards in the shared drawer. Each actionable card composes a focused mutation fragment that retains the existing API, validation, audit-reason, refresh, and close behavior; non-actionable cards expose the current state honestly without adding mutations.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Testing Library, Vitest

**Spec:** `docs/superpowers/specs/2026-09-17-b2c-payment-review-drawer-redesign-design.md`

## Global Constraints

- Treat `old-project/` as read-only and keep existing unrelated worktree changes out of the commit.
- Preserve `kind: "workItem"` behavior unchanged.
- Do not change SQL, RPCs, migrations, reportability logic, API route contracts, or `src/lib/b2c/payment-decision.ts`.
- Preserve the existing Admin-only mutation and evidence boundaries; Viewer rendering remains read-only.
- Add only the approved TypeScript-side read of an excluded payment's audited duplicate resolution reason; RLS and the drawer must keep it hidden from Viewers, with the generic decision explanation as fallback.
- Render payment cards in the exact canonical order supplied by `row.decision.blockingReasons`.
- The first card is open by default; every later card is closed but its title remains visible.
- Keep source evidence and audit history inside one closed-by-default `Show source evidence & history` disclosure.
- Use `StatusBadge` for `Reportable`, `Blocked`, `Excluded`, and `Included by exception`.
- Run `npx tsc --noEmit`, `npm run lint`, and `npx vitest run --no-file-parallelism` before committing.
- Do not run Supabase reset, push, migration, or linked-project CLI commands; do not push the git commit.

---

### Task 1: Specify the new drawer behavior with regression tests

**Files:**
- Modify: `tests/b2c-payment-review-drawer.test.tsx`
- Modify as needed: `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- Modify as needed: `tests/b2c-workspace-ui.test.tsx`

**Interfaces:**
- Consumes: `B2cPaymentReviewDrawer`, `B2cReviewRow`, and the existing row fixture shape.
- Produces: assertions for card titles, native disclosure state, focused actions, read-only tags, combined evidence/history disclosure, and reporting status chips.

- [ ] **Step 1: Replace old-section assertions with the new shell contract**

  Render a reportable row and assert `What this record needs`, `Ready to report — nothing needed`, and the `Reportable` status badge are present. Assert `Local values`, `Finance decision`, the free-text reporting explanation, and separate top-level evidence/history sections are absent.

- [ ] **Step 2: Add the multi-reason disclosure test**

  Build one row with `blockingReasons: ["missing_amount", "missing_business_date", "missing_customer_email"]`. Locate each card by its `<details>` element, assert all titles exist in the DOM, assert only the first has `open`, and assert amount/date/email actions are scoped to their owning cards.

- [ ] **Step 3: Add the no-action-state table test**

  Cover `failed_payment`, `pending_payment`, `duplicate_exclusion`, and `other_open_review`. Assert each title and tag (`No action needed`, or `No action needed here yet`) is visible, no action button appears in its card, and the review flag's literal reason is rendered for `other_open_review`.

- [ ] **Step 4: Add the combined evidence/history test**

  Assert exactly one `Show source evidence & history` `<summary>` exists, its `<details>` is closed by default, and both the source evidence and audit-history content are descendants of that disclosure.

- [ ] **Step 5: Update existing mutation tests to the focused fields/buttons**

  Use `Local B2C amount (USD)` + `Save amount`, `Local business date` + the appropriate date label, and `Customer email` + `Save email`. Keep failure-preserves-draft and success-closes-drawer assertions against the unchanged `/correct` endpoint.

- [ ] **Step 6: Run the focused test and verify RED**

  Run: `npx vitest run tests/b2c-payment-review-drawer.test.tsx --no-file-parallelism`

  Expected: failures identify the missing card layout, status chips, focused forms, and combined disclosure rather than fixture or syntax errors.

### Task 2: Split payment mutations into per-card action fragments

**Files:**
- Modify: `src/features/b2c/b2c-payment-review-actions.tsx`

**Interfaces:**
- Consumes: `B2cReviewRow`, `onSaved: () => void`, existing Admin role context, router refresh, and existing `/correct`, `/fx-conversion`, and `/finance-exception` endpoints.
- Produces: `B2cPaymentAmountCorrection`, `B2cPaymentBusinessDateCorrection`, `B2cPaymentEmailCorrection`, `B2cPaymentFinanceException`, and `B2cPaymentFxConversion`.

- [ ] **Step 1: Extract a focused local-correction state helper**

  Each local correction component owns one draft value plus one reason, sends only its one changed field and `reason`, disables save until the value changed and the reason is meaningful, preserves the draft on error, and refreshes/closes only after success.

- [ ] **Step 2: Implement the amount fragment**

  Render `Local B2C amount (USD)`, source amount context, `Reason / evidence`, and `Save amount`. Keep foreign-currency USD entry disabled because FX owns that path.

- [ ] **Step 3: Implement the date fragment**

  Accept `saveLabel: "Save date" | "Save corrected date"`; render only `Local business date`, source date context, its own reason, and the supplied save label.

- [ ] **Step 4: Implement the email fragment**

  Render only `Customer email`, retained fallback suggestion text, its own reason, and `Save email` with the current lower-case normalization.

- [ ] **Step 5: Implement the Finance-exception fragment**

  Retain the two confirmations, meaningful reason, existing eligibility gates, request body, error behavior, and `Include in PLAYBOOK Finance` button. Remove references to the deleted `Local values` section.

- [ ] **Step 6: Implement the FX fragment**

  Retain rate/source/effective-date inputs, its own reason, request body, existing endpoint, server error behavior, and a `Save conversion` button.

- [ ] **Step 7: Remove obsolete combined exports and run the focused test**

  Delete `B2cPaymentLocalValuesFragment`, `B2cPaymentFinanceDecisionFragment`, `B2cPaymentActionPrimary`, nested action disclosures, and shared `More actions` logic.

  Run: `npx vitest run tests/b2c-payment-review-drawer.test.tsx --no-file-parallelism`

  Expected: focused fragment tests progress to card-shell failures; no TypeScript/runtime errors come from the new exports.

### Task 3: Render one card per unresolved reason

**Files:**
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Modify: `src/features/b2c/b2c-payment-duplicate-review.tsx`
- Modify: `src/components/ui.tsx`
- Modify only if copy requires it: `src/features/b2c/b2c-refund-fx-review-actions.tsx`

**Interfaces:**
- Consumes: `row.decision.blockingReasons`, the five focused payment fragments, `B2cPaymentDuplicateReview`, and `B2cRefundFxReviewActions`.
- Produces: `BlockingReasonCards`, an accessible native `<details>` card shell, and the direct reason-to-card rendering map.

- [ ] **Step 1: Add the reusable card shell**

  Render each card as `<details open={index === 0}>` with a keyboard-operable `<summary>`, plain-language title, one-sentence explanation, and an expanded body separated by a border. Do not hide any card title behind a shared disclosure.

- [ ] **Step 2: Map all ten payment reasons**

  Use the exact titles from the spec. Compose amount, date, corrected-date, email+exception, FX, and duplicate controls for actionable reasons. Render status tags and supporting text only for `duplicate_exclusion`, `failed_payment`, `pending_payment`, and `other_open_review`; the latter takes literal reasons from `Needs follow-up` flags.

- [ ] **Step 3: Add reportable and refund cards**

  For zero payment reasons, render `Ready to report — nothing needed`. For refunds, keep the existing FX fragment for foreign currency and the current no-further-decision message otherwise, each inside one card shell.

- [ ] **Step 4: Preserve Viewer behavior per card**

  Keep titles and explanations visible to Viewers, replace actionable bodies with the existing read-only note, and avoid rendering mutation controls.

- [ ] **Step 5: Replace summary decision text with a status chip**

  Map `reportable → Reportable`, `blocked → Blocked`, `excluded → Excluded`, and `exception_included → Included by exception`, rendered through `StatusBadge`. Add those four labels to the existing `StatusBadge` style map so reportable/exception states follow the success convention and blocked/excluded states follow the warning convention.

- [ ] **Step 6: Combine evidence and history**

  Put both `B2cSourceEvidencePanel` and `B2cAuditTimeline` under one closed-by-default `<details>` with summary `Show source evidence & history`, retaining internal headings for screen-reader and visual structure.

- [ ] **Step 7: Remove the single-pick path and update duplicate copy**

  Delete `DrawerPrimaryAction`, `REASON_TO_ACTION`, `primaryActionForRow`, and `ActionSlot`. Change the duplicate `keep_one` button label from `Keep selected payment` to `Keep only this one`; leave its request logic unchanged.

- [ ] **Step 8: Run drawer and duplicate UI tests and verify GREEN**

  Run: `npx vitest run tests/b2c-payment-review-drawer.test.tsx tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-payment-duplicate-routing.test.tsx tests/b2c-workspace-ui.test.tsx --no-file-parallelism`

  Expected: all selected test files pass.

### Task 4: Align coupled tests and architecture documentation

**Files:**
- Modify as needed: `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- Modify as needed: `tests/b2c-workspace-ui.test.tsx`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: the finished shared drawer behavior.
- Produces: repository documentation that no longer describes the removed primary/More-actions model.

- [ ] **Step 1: Run coupled tests**

  Run: `npx vitest run tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-workspace-ui.test.tsx --no-file-parallelism`

  Update only assertions actually coupled to the previous drawer structure; retain evidence-fallback assertions.

- [ ] **Step 2: Update the architecture paragraph**

  Describe the canonical blocking-reason card list, focused actions, and single evidence/history disclosure. Preserve the existing safe evidence-fetch and reportability boundaries.

- [ ] **Step 3: Search for stale implementation references**

  Run: `rg -n "primaryActionForRow|ActionSlot|REASON_TO_ACTION|B2cPaymentLocalValuesFragment|B2cPaymentFinanceDecisionFragment|More actions|Local values|Finance decision" src/features/b2c tests docs/ARCHITECTURE.md`

  Expected: no references to the deleted drawer model remain; unrelated source-management disclosures may still use their own `More actions` label.

### Task 5: Verify, review, and commit

**Files:**
- Review every changed file; stage only task-owned paths.

**Interfaces:**
- Consumes: the complete implementation and tests.
- Produces: one local commit, no push.

- [ ] **Step 1: Run focused regression tests**

  Run: `npx vitest run tests/b2c-payment-review-drawer.test.tsx tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-payment-duplicate-routing.test.tsx tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-workspace-ui.test.tsx --no-file-parallelism`

- [ ] **Step 2: Run TypeScript and lint**

  Run: `npx tsc --noEmit`

  Run: `npm run lint`

- [ ] **Step 3: Run the complete single-threaded suite**

  Run: `npx vitest run --no-file-parallelism`

- [ ] **Step 4: Review scope and repository state**

  Run: `git diff --check`, `git diff --stat`, `git diff -- <task-owned paths>`, and `git status --short`.

  Confirm there are no SQL/RPC/migration/reportability changes, no edits in `old-project/`, no debug code, and no unrelated user changes staged.

- [ ] **Step 5: Commit locally**

  Stage only the plan, drawer/actions/duplicate files, coupled tests, and architecture guide, then commit with:

  ```bash
  git commit -m "feat(b2c): redesign payment review drawer"
  ```

  Do not push.
