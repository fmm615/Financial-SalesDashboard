# B2C Exact-Duplicate Reconciliation Design

**Date:** 12 August 2026  
**Status:** Approved for planning  
**Scope:** Review-first consolidation of exact duplicate Finance rows from the
Payment Tracker `B2C` and `B2C Cons` tabs

## Goal

Make an exact duplicate appearing in both Finance Payment Tracker tabs
represent one potential B2C sale, while retaining both original source rows.
No reconciliation activity may publish revenue, create a `b2c_payments` row,
or change a total, target, or report.

## Source roles

The Finance Payment Tracker is the only source of B2C Finance revenue
candidates. `B2C` and `B2C Cons` overlap and must not be added together.

Stripe Charges and Tap statements are provider evidence only. They may help an
Admin investigate a Finance row, but cannot create a Finance revenue row or
be automatically linked as a confirmed match. The currently supplied Payment
Tracker tabs do not contain provider transaction IDs, so no automatic
provider-ID reconciliation is possible from those files.

## Exact duplicate rule

An exact cross-tab duplicate candidate requires all of the following:

1. one row comes from `B2C` and one from `B2C Cons` in a completed Payment
   Tracker import;
2. both rows are valid candidates with the same business date, USD amount,
   category, and payment method;
3. if both rows have a direct provider ID in a future supported field, those
   IDs are equal; otherwise, both have the same normalized direct customer
   email; and
4. when e-mail is absent, both have the same normalized customer name and
   phone number.

Blank fields, conflicting fields, merely similar names, nearby dates, or a
matching amount alone are not exact duplicates. They remain independent,
non-reportable source rows for review. The rule never treats recurring
payments as duplicates merely because they have the same customer and amount.

## Reconciliation flow

1. An authenticated Admin starts a grouping run after the Payment Tracker
   source has completed.
2. The server reads the staged Finance rows and constructs only deterministic
   cross-tab exact-duplicate candidate groups. It performs no browser-side
   financial logic.
3. Each group preserves references to both Finance rows and records the
   initial `exact_duplicate_candidate` state.
4. The Admin sees the source rows side by side and selects either:
   - **Canonical** — exactly one row in the group is selected; or
   - **Excluded** — the entire group is excluded with a documented reason.
5. The database records the actor, timestamp, state, selected source row (if
   canonical), and reason in its append-only decision history. A decided group
   cannot be altered or silently reopened.
6. A canonical decision identifies one retained Finance candidate only. A
   later, separate Finance period-approval workflow is required before any
   B2C figure is reportable.

## Safety and access

- The grouping and decision routes are Admin-only and use a request-scoped
  authenticated Supabase client; RLS remains the enforcement layer.
- Viewers receive only existing safe coverage counts, never source rows,
  customer contacts, provider identifiers, or decisions controls.
- The grouping run is idempotent. Re-running it must not create another group
  for an already grouped Finance row.
- Both source rows remain immutable evidence. Neither is deleted or overwritten.
- No action writes to `b2c_payments`, reportable views, targets, reports, or
  provider systems.

## Provider-evidence follow-up

The first release does not make automatic Stripe/Tap matches. Later Admin
review may show conservative provider-evidence suggestions based on direct
source data, but only as investigation context. A provider source ID can be
an exact link only if that ID is also present in a Finance source row; any
other resemblance requires a documented Finance decision and remains outside
automatic counting.

## Failure handling

- A grouping run fails safely if the required completed Payment Tracker import
  is missing or the database cannot persist a complete result.
- Invalid/zero/needs-review Finance rows are never repaired, discarded, or
  promoted by grouping.
- A rerun reports the authoritative retained state after an interrupted
  browser request; idempotency prevents duplicate groups.
- User-facing errors remain safe and do not disclose raw Finance data.

## Verification

- Pure matching tests: valid exact pairs, e-mail fallback safety, missing-field
  rejection, category/method/date conflicts, and recurring-payment safety.
- Repository/API tests: authenticated Admin boundary, idempotent creation,
  append-only one-time decisions, and rejection of a canonical row outside its
  group.
- UI tests: Admin can review a candidate and submit a reason; Viewer sees no
  raw rows or decision controls; no B2C revenue total is displayed.
- Database tests: grouping and decisions remain RLS-protected and no code path
  writes `b2c_payments`.
- Full TypeScript, lint, relevant tests, production build, and `git diff
  --check` run before completion. Local pgTAP remains dependent on a local
  Supabase CLI and manually applied migrations.

## Non-goals

- Publishing B2C revenue, changing targets, reports, or Executive figures.
- Deleting, merging, correcting, or changing imported Finance rows.
- Currency conversion or treating Tap BHD values as USD.
- Live Stripe/Tap calls, webhook changes, or provider API backfill.
- Automatic reconciliation from names, dates, amounts, or contact data alone.
