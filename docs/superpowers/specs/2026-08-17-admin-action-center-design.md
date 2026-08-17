# Admin Action Center Design

## Goal

Give PLAYBOOK administrators one clear starting point for every financial decision, correction, retry, and source-data problem, while keeping specialised work focused, auditable, and safe.

## Why this is needed

Administration is currently fragmented across Administration, Review Queue, B2C Reconciliation, B2C Operations, B2B Operations, Targets, Reports, and Audit Log. An administrator must already know which page owns a problem before they can resolve it. That contradicts the requirement for one place to see records needing a human decision before month-end.

The Admin Action Center is the single front door. It is not a large form containing every possible control. It tells an administrator what needs attention in plain language and sends them to the correct focused workspace.

## Users and permissions

- Administrators can view and act on the Action Center and its modules.
- Viewers cannot access correction, reconciliation, import, retry, or posting controls.
- Each change requires the authenticated administrator, a timestamp, an auditable reason, and a before/after record when a value changes.
- Source evidence is immutable. Corrections are recorded as auditable overrides; the uploaded workbook and provider evidence are never rewritten.

## Navigation

The primary navigation contains one admin entry: **Admin Action Center**.

Existing direct URLs remain valid for bookmarks and existing links, but they redirect to the relevant Action Center module or become read-only detail pages. The duplicated primary-navigation entries for Review Queue and Administration are removed. Audit Log remains available as a separate admin-only history page.

The Action Center links to the following focused modules:

| Module | Purpose | Includes |
|---|---|---|
| B2C Finance | Resolve B2C source and ledger readiness | Finance workbook intake, duplicate decisions, corrections, provider comparison, approved ledger posting, bank-transfer entry |
| B2B Sales | Resolve corporate-deal reporting issues | Missing amount or close date, duplicate deals, recognised-sale decisions, manual B2B entries |
| Products and categories | Make source products reportable | Stripe and Tap product mappings, membership-tier mapping |
| Integrations | Maintain provider coverage | Stripe, Tap, and HubSpot status, retry, and historical backfill |
| Reports | Complete reporting work | Failed report jobs, retry, download, and delivery history |
| Targets and Summit | Maintain approved plans | Financial targets, operational targets, summit progress |
| Audit and access | Inspect governance history | Audit Log and user-access controls when those controls are live |

## Action Center page

The page uses the existing PLAYBOOK light dashboard visual system and dense-but-readable cards and tables. It does not expose raw database IDs by default.

### 1. Summary

Four summary cards appear first:

- Revenue blockers
- Open decisions
- Failed processes
- Resolved today

Cards are buttons. Selecting a card applies a plain-language filter to the queue below.

### 2. Needs attention queue

Every item has one business-readable explanation, its source area, financial impact, and one verb-led next action: **Review**, **Correct**, **Map**, **Retry**, or **Resolve**.

The queue groups items in this order:

1. Revenue blockers
2. Duplicate decisions
3. Missing or conflicting information
4. Failed integrations and report jobs
5. Non-blocking follow-up

The default view shows open items only. Administrators can filter by module, status, and impact, then search. Statuses are **Open**, **Resolved**, and **Dismissed**. Resolved and dismissed work remains visible in history.

The Action Center presents an action-level count, not an inflated source-row count. For example, two Finance rows that describe one possible duplicate payment appear as one duplicate-decision item.

### 3. Quick actions

The queue is followed by a small fixed set of shortcuts:

- Add bank transfer
- Import Finance workbook
- Reconcile B2C provider evidence
- Run provider sync
- Generate report

These buttons open the relevant focused module. They do not execute financial mutations immediately. A shortcut appears only when its underlying authorised workflow is live; a required but unfinished control is labelled **Not available yet**, never presented as a form that appears to save.

### 4. Modules

Module cards appear below the queue. Each card shows its open-item count, a one-sentence purpose, and an **Open module** button. This preserves one entry point without creating a long, confusing page.

## Work-item architecture

The Action Center does not create a second source of truth for payments, deals, reports, or provider data. A server-side aggregator reads the authoritative records already used by each workflow:

- `review_flags` and their notes/resolutions
- B2C Finance staging rows and reconciliation groups
- B2C payments, refunds, FX reviews, product mappings, and Finance exceptions
- B2B deal review and duplicate data
- Integration errors and sync runs
- Report jobs and delivery attempts
- Target and Summit workflows

Each adapter returns the same safe Action Center shape:

```ts
type AdminActionItem = {
  id: string;
  module: "b2c_finance" | "b2b_sales" | "products" | "integrations" | "reports" | "targets" | "governance";
  category: "revenue_blocker" | "duplicate" | "data_quality" | "process_failure" | "follow_up";
  status: "open" | "resolved" | "dismissed";
  title: string;
  explanation: string;
  impact: "blocks_revenue" | "needs_attention" | "information";
  actionLabel: "Review" | "Correct" | "Map" | "Retry" | "Resolve";
  href: string;
  createdAt: string;
};
```

The Action Center is read-only until an administrator opens a source-specific module. Existing source-specific database functions remain responsible for validation, idempotency, permissions, audit records, and mutation.

## B2C Finance module

The B2C Finance module is the first live Action Center module because the current Finance workbook has 58 decisions represented by 101 source rows.

### Finance duplicate decisions

An exact Finance duplicate is one B2C row and one B2C Cons row with the same normalized customer name, date, amount, and payment method. It is one decision, not two payments.

The module shows both rows side by side, explains the match, and lets Finance select the canonical row or exclude the whole group. A reason is mandatory.

For a group, the module may recommend B2C Cons only when it contains more usable business fields than B2C. A bulk action is available only for groups with that same provable recommendation. Before saving, it displays the number of groups, selected source tab, and required reason. Confirming the action writes an individual audited canonical decision for every group. It never posts both rows.

For the currently staged workbook, there are 43 such duplicate groups. The B2C Cons row is more complete in all 43 groups. The recommended bulk decision is therefore to retain B2C Cons and exclude the B2C copy.

### Date-label conflicts

When the main Date value is valid but the separate Month or Year label conflicts, the Date value is authoritative. Month and Year are derived values for reporting, not independent booking dates.

The module presents a grouped action labelled **Use verified Date values**. Confirming it records an audit event for each affected source row, retains the original Month/Year text as evidence, and makes the rows eligible for posting. It does not silently overwrite the workbook values.

The current workbook contains ten date-label conflicts: nine Month conflicts and one Year conflict.

### Required corrections

Rows with an unreadable or missing main Date, missing customer name, missing positive amount, or missing reportable category cannot be posted. The module presents one correction form per row:

- Original source value
- Verified corrected value
- Required reason and evidence note
- Administrator identity and timestamp

Corrections are stored separately from the original Finance row. The effective Finance record used by posting and reporting combines the original record with its latest approved correction. The original evidence remains visible in the correction history.

The current workbook has four unreadable dates and one missing customer name that require this workflow.

### Posting

After duplicate decisions and data-quality work are resolved, the B2C Finance module displays an explicit **Post verified Finance payments** step. It shows the count that will enter the ledger and the count intentionally excluded as duplicate copies. Posting remains idempotent and can be safely retried.

For the current workbook, the maximum correct result is 219 unique ledger payments: 161 already posted, 43 canonical duplicate decisions, and 15 corrected or date-policy-resolved rows. The 43 duplicate copies remain permanently excluded so revenue is not double-counted.

## Other modules

The Action Center uses the same structure for the rest of the system:

- **B2B Sales:** missing close date, amount, category, possible duplicate, excluded deal, and recognised-sale work.
- **Products and categories:** unmapped Stripe and Tap products, with mapping forms and audit reasons.
- **Integrations:** failed runs, stale coverage, manual sync, and resumable backfill; provider clients remain read-only where required.
- **Reports:** failed or stalled report jobs, retries, downloads, and delivery history. Automatic email remains disabled until report totals are verified.
- **Targets and Summit:** approved target revisions and progress updates; these remain configuration actions rather than queue blockers unless they prevent a required report.
- **Bank transfers:** a dedicated controlled entry form in B2C Finance once its final business fields and duplicate-key policy are approved. It uses the same duplicate checks and audit rules as imported/provider payments. Until then, the Action Center states that the control is not available rather than showing a non-functional entry form.

## Safety and error handling

- Every mutation is administrator-only and validates input on the server.
- High-impact actions show a clear confirmation that states what will change and what will not change.
- Buttons disable while saving and show a plain-language success or failure message.
- A failed action leaves source evidence unchanged and provides a safe reference code for support.
- No action deletes source evidence, ledger rows, flags, corrections, or audit history.
- The UI uses visible labels, keyboard-accessible controls, announced errors, adequate contrast, and responsive tables/cards.

## Delivery order

### Phase 1: Action Center and current B2C resolution

1. Add the Admin Action Center route, navigation entry, unified read-only queue, filters, summary counts, quick actions, and module cards.
2. Move admin-only B2C Finance intake, duplicate review, corrections, and posting into the B2C Finance module.
3. Add immutable Finance correction overrides and the effective-record posting rules.
4. Add the audited bulk B2C Cons canonical-decision workflow and Date-authority action.
5. Preserve existing direct URLs through redirects or clear module links.

### Phase 2: Remaining live workflows

1. Add adapters and deep links for B2B review, product mapping, integration recovery, reports, and targets.
2. Remove duplicated navigation entries after the Action Center has equivalent links.
3. Ensure every existing live action can be reached from one Action Center module.

### Phase 3: Governance completion

1. Add user-access management only when it has a real authorised backend.
2. Add assignment or ownership only if the Finance team grows beyond the current small operating group; it is not required for the initial workflow.

## Acceptance criteria

- An administrator can start at one page and find every open financial decision without knowing the original page.
- A viewer cannot access any mutation or sensitive source details.
- B2C duplicate pairs display as one decision and cannot result in double-counted ledger revenue.
- A valid Date with a conflicting Month/Year label can be resolved with an explicit, audited Date-authority action.
- A missing or unreadable required value can be corrected without altering the original workbook evidence.
- Every source-specific action records the administrator, timestamp, reason, and before/after values when applicable.
- Existing B2B, B2C, mappings, integration, reports, targets, and bank-transfer workflows are reachable from the Action Center.
- Existing direct links do not become dead ends.
- No automatic report email or provider write operation is introduced.
