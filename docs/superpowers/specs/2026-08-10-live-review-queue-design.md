# Live Review Queue Design

**Date:** 2026-08-10  
**Status:** Approved for specification; implementation waits for user review of this document.

## Goal

Replace the mock Review Queue with a safe, live operational queue backed by the
existing `review_flags`, `review_flag_resolutions`, and `review_notes` tables.
It gives the team one truthful place to find records requiring attention before
month-end while B2B and B2C source data and final financial rules are still
being settled.

This work implements the requirements-reference Section 08 foundation:

- show refunded, failed, possible-duplicate, unmapped-product, and
  needs-follow-up records;
- keep every resolution and note in history;
- never delete flags or source records;
- require an attributable note for any direct queue action.

## Scope and non-goals

The queue is a review hub, not a second financial system. It reads real flags,
source context, notes, and resolution history, then takes the reviewer to the
existing source-specific workflow when a correction or financial decision is
needed.

It does **not**:

- calculate, display, or invent B2B/B2C totals;
- edit provider records, provider payloads, bookings, receipts, recognised
  sales, or payment amounts;
- turn missing values into zero;
- add Resend, Slack, emails, schedules, or automatic closure;
- introduce a B2C duplicate-decision rule before Finance has defined it.

## Safety boundary

An open `possible_duplicate` B2C flag excludes a succeeded payment from
financial totals. The current generic B2C resolution RPC can clear any B2C
flag, which would make such a payment reportable without an explicit
keep/exclude decision. That is unsafe.

The implementation will add a narrow migration that makes the generic B2C
resolution RPC reject `possible_duplicate` flags. Existing source-specific
workflows continue to resolve only the flags they actually fix, such as an
unmapped-product flag after a verified product mapping.

B2B duplicate flags already have a dedicated Admin duplicate-group decision:
keep both deals or keep one, with the excluded deal retained locally and the
decision audited. The live queue links to that workflow; it does not duplicate
or bypass it.

B2C duplicate confirmation needs a future dedicated group/keep-exclude design.
Until B2C data and that rule are final, the queue shows the flag, its source
context, and the reason it remains open. A reviewer can add notes but cannot
clear it through a misleading generic button.

## Architecture

### Read model

Create a focused Review Queue repository and service:

1. The repository reads approved-user-visible review flags and joins the
   minimum source context needed to identify the record. It uses the
   request-scoped authenticated Supabase client, preserving RLS.
2. The service converts database rows to explicit UI domain types. It owns
   labels, safe source references, suggested next actions, filtering, sorting,
   and derived counts. It contains no financial calculation.
3. A thin authenticated route validates query input and returns the service
   result. The UI consumes this route rather than Supabase row shapes or mock
   data.

The list defaults to open flags, with filters for text, flag type, priority,
and status. Resolved and dismissed flags remain available in the history view.
Counts are derived from the same query result, rather than hard-coded mock
values.

### Detail model

Opening a queue row shows:

- flag type, status, priority, created/resolved dates, and reason;
- safe source reference and source area;
- the appropriate next action and destination;
- immutable resolution history and append-only notes;
- an explicit statement when the source data is unavailable or no direct
  resolution is safe.

No provider payload, secret, raw integration error, or hidden financial value
is exposed in the queue.

### Actions

The UI distinguishes navigation from mutation:

| Flag/source | Queue behaviour |
|---|---|
| B2B possible duplicate | Link to the existing B2B duplicate-review workflow. |
| B2C possible duplicate | Keep open; allow an Admin note only; show that a future verified duplicate decision is required. |
| Unmapped B2C product | Link to B2C Operations, where verified local mapping resolves the matching flag. |
| B2B incomplete/missing-data flag | Link to B2B Operations, where the existing audited correction decides its disposition. |
| Integration flag | Link to the existing integration/Admin workflow when one exists; otherwise leave open with notes. |
| Other manually reviewable flags | Allow only a server-validated, Admin-only note or a direct closure where the underlying rule confirms that closure cannot alter financial inclusion. |

The first implementation will not expose a generic “Mark as reviewed” action.
That mock action is removed because it changes screen state without a durable,
audited server-side decision. Direct close actions are added only after their
source-specific financial effect is explicit and tested.

## Authorization, validation, and audit

- Approved users may read the queue under existing RLS.
- Admin-only writes use a request-scoped authenticated client so PostgreSQL
  records `auth.uid()` for notes and resolutions.
- API query parameters, IDs, and note text use Zod validation. Notes require
  meaningful non-blank text and a bounded length.
- The database remains the authority for role checks, resolution transitions,
  audit snapshots, and retained history. Hiding a button is presentation only.
- Failed reads or writes show a safe error and leave the item unchanged. The UI
  must never claim a save occurred when the database rejects it.

## UI changes

The existing visual shell remains, but mock data and client-only status state
are removed. The page gains real loading, empty, and error states; functional
search/filter controls; computed metric cards; and a detail drawer populated
from the real detail endpoint. Viewer drawers are read-only. Admin drawers can
add a note where permitted and use the source-specific next-action link.

The page stays useful before data is loaded: it shows an honest empty state,
not invented sample records or zero financial values.

## Database and documentation

The review-queue tables, audit triggers, and RLS policies already exist, so no
new queue table is needed. One migration updates the generic B2C resolution RPC
to prohibit possible-duplicate closure. This preserves the existing B2B
duplicate decision boundary and prevents accidental financial inclusion.

Update the relevant architecture/testing documentation to record the live
queue boundary, the duplicate safeguard, and the remaining B2C duplicate
decision dependency.

## Tests and acceptance criteria

Add tests before implementation for:

1. repository/service mapping, derived counts, filters, and source-specific
   suggested actions;
2. request validation, approved-user reads, Admin-only note writes, and safe
   failed-operation responses;
3. the database contract that a generic B2C resolution cannot close a possible
   duplicate, while source-specific correction flows remain valid;
4. UI loading, empty, real-list, filter, history, and Viewer/Admin states;
5. the regression rule that no client-only action can make a queue item appear
   resolved.

Acceptance means the queue has no mock records or hard-coded metrics, all
history remains visible, no action changes an unsettled B2B/B2C financial
result, and the focused tests plus typecheck, lint, and build pass.

## Deferred follow-up

When Finance finalises B2C duplicate rules and provider data, design a
dedicated B2C duplicate-group workflow that requires an explicit, audited
keep/exclude decision. It must update reportability without mutating Stripe or
Tap and must never make both candidate records silently reportable.
