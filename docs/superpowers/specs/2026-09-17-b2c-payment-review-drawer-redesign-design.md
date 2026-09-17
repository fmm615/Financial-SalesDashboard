# B2C Payment Review Drawer Redesign Design

**Date:** 2026-09-17

**Status:** Approved

**Scope:** Restructure the shared B2C payment review drawer (`src/features/b2c/b2c-payment-review-drawer.tsx` and its action fragments) so every open Admin sees, without scrolling past unrelated sections, exactly what is blocking a record and exactly one clear action per blocker. No database schema, RPC, or reportability-logic changes.

## Context

The drawer is the single shared surface Work Queue and Ledger both open to resolve a B2C record. Today it always renders, in fixed order: a summary `dl`, "Source evidence", "Local values" (a flat form with every editable field regardless of which one is actually missing), "Finance decision" (one auto-picked primary action plus everything else collapsed under "More actions"), and "Audit history".

An Admin reported the drawer as "very complicated... admins won't know what to do and how, like what is required and what this page can do." A structural review of every blocking-reason scenario confirmed concrete problems, not just a vague complexity complaint:

- `primaryActionForRow` picks only the **first** matching blocking reason and auto-expands its action. Every other still-relevant action (e.g. the Finance-exception panel for `missing_customer_email`) renders collapsed inside a shared "More actions" disclosure, even when `explain()` explicitly tells the Admin to use it ("An Admin can still include it in Finance through an audited exception below").
- A record can carry multiple blocking reasons at once (`blocking_reasons` is a documented superset), but the drawer never shows more than one as prominent. An Admin who resolves the visible one and closes the drawer has no signal that a second blocker remains.
- `failed_payment`, `pending_payment`, and `duplicate_exclusion` have no `REASON_PLAN` entry and no resolution UI at all — they surface only as a sentence inside the shared explanation paragraph, indistinguishable from an actionable blocker until read carefully.
- "Local values" is one static form with every field (name, email, mobile, plan, amount, business date) always visible, regardless of which single field is actually the blocker — an Admin must infer which field matters from the top summary explanation.
- `other_open_review` nominally maps to the `"correct"` action, but no field in "Local values" resolves it; its only real surface is a read-only "Open review flags" list with no action control, buried in "More actions".

## Decision

Replace the "Local values" + "Finance decision" sections with a single new section, **"What this record needs"**, built from one card per currently unresolved blocking reason on the row. Every card is listed — nothing is hidden behind a pick-one "primary" selection — so an Admin always sees everything blocking the record, not just the first thing the code happened to check first.

- Zero blocking reasons renders one card: a green "Ready to report — nothing needed" state.
- One or more blocking reasons renders one card per reason, in the record's existing canonical `blockingReasons` order. The first card starts expanded; the rest start collapsed but are always visible by title, and expand on click.
- Each card carries a plain-language title, a one-sentence explanation of what's wrong, and the actual fix built directly into the card body — no separate form elsewhere to connect back to it.
- Reasons with no real fix (`failed_payment`, `pending_payment`, `duplicate_exclusion`) render a card with a "No action needed" tag and the plain reason, instead of the current buried sentence.

"Source evidence" and "Audit history" — both read-only — collapse into one closed-by-default disclosure, **"Show source evidence & history"**, at the bottom of the drawer. They remain fully available, just out of the way of the action the Admin actually needs to take.

The top summary's "Reporting decision" free-text sentence is replaced with a short status chip (**Reportable** / **Blocked** / **Excluded** / **Included by exception**), colored to match `StatusBadge` conventions already used elsewhere in the drawer. The existing evidence-fallback hints ("From Stripe profile — not yet verified") on Customer/Email in the summary are unchanged.

The `kind: "workItem"` drawer path (opened for a deep link whose full row isn't loaded yet) is unchanged — it remains a redirect prompt with no actionable UI, as today.

### `other_open_review` — explicitly scoped out of this change

No new "resolve this flag" action is built. The current data model has no mechanism to resolve an `other_open_review` flag independent of a specific verified correction, and building one is a distinct feature, not a relabeling. This redesign only makes the existing state honest: the flag's specific reason text renders directly in its card (today it requires opening "Open review flags" inside "More actions" to see), with a "No action needed here yet" tag rather than implying "correct" fixes it.

## Alternatives considered

### Single-step wizard (show only the highest-priority unresolved reason, advance after each save)

Keeps each screen minimal, but hides scope: an Admin fixing the visible reason has no way to know a second blocker exists until the drawer re-evaluates after save. Rejected — the reported problem is "admins won't know what to do," and hiding remaining blockers makes that worse, not better.

### Keep one auto-picked "primary" card, collapse the rest under "More actions" (today's model, just re-skinned)

Smaller change, but does not fix the core problem: the Finance-exception panel for `missing_customer_email` is exactly the kind of action that gets silently buried today, which is what triggered this redesign in the first place. Rejected.

### All-cards-always-expanded (no collapse at all)

Considered for records with several simultaneous blockers, but risks recreating "wall of sections" for a record with 3+ reasons. Selected the expand-first/collapsed-but-listed compromise instead: full visibility of what's outstanding, without forcing every card open at once.

## Card content per blocking reason

| Reason | Card title | Inline body |
|---|---|---|
| `missing_amount` | Missing amount | Amount input + **Save amount** |
| `missing_business_date` | Missing business date | Date input + **Save date** |
| `implausible_future_date` | Business date looks wrong | Date input (same field as above) + **Save corrected date** |
| `missing_customer_email` | Missing customer email | Email input + **Save email**, and a secondary **Include without email** control that opens the existing reason + 2-checkbox exception form (`b2c_payment_finance_exception_decisions`, unchanged logic) |
| `missing_fx` | Needs currency conversion | Rate / conversion source / effective date inputs + **Save conversion** (reuses `B2cPaymentFinanceDecisionFragment`'s existing FX block/state, relabeled) |
| `possible_duplicate` | Possible duplicate | Existing `B2cPaymentDuplicateReview` comparison UI; buttons relabeled **Keep all payments** / **Keep only this one** |
| `duplicate_exclusion` | Excluded as duplicate | No button. "No action needed" tag + the audited exclusion reason shown directly |
| `failed_payment` | Payment failed | No button. "No action needed" tag + one-line why (matches existing `explain()` wording) |
| `pending_payment` | Payment pending | No button. "No action needed" tag + one-line why |
| `other_open_review` | Open review item | No button. Shows the specific flag's `reason` text directly (moved out of the collapsed "Open review flags" list) |

Refund rows keep their existing behavior (`B2cRefundFxReviewActions` for foreign-currency refunds, "This refund needs no further Finance decision" otherwise) but render inside the same one-card layout for consistency, instead of a bespoke `ActionSlot` branch.

## Component changes

- `b2c-payment-review-drawer.tsx`: remove the fixed "Local values" / "Finance decision" `Section`s and `primaryActionForRow`/`ActionSlot`/`REASON_TO_ACTION` single-pick logic. Replace with a `BlockingReasonCards` component that maps `row.decision.blockingReasons` (or the refund equivalent) to the card list above, each card owning its own expand/collapse state (first card defaulting open). Replace `RowSummary`'s "Reporting decision" `<dd>` with the new status chip. Wrap `B2cSourceEvidencePanel` + `B2cAuditTimeline` in one collapsed-by-default `<details>` disclosure.
- `b2c-payment-review-actions.tsx`: split `B2cPaymentLocalValuesFragment`'s flat form into per-field pieces so each card can render only the one field it owns (amount, business date, or email) plus its own reason/evidence input and Save button, instead of one shared form covering every field at once. `B2cPaymentFinanceDecisionFragment`'s FX block, exception block, and review-flags list are similarly split so each becomes a standalone card body rather than a combined fragment gated by a single `primary` prop.
- `b2c-refund-fx-review-actions.tsx`, `b2c-payment-duplicate-review.tsx`: no logic changes; button label updates only, and rendered inside the new card shell rather than directly inside a `Section`.
- `payment-decision.ts`: no changes. `explain()`'s sentence remains available as supporting text where useful (e.g. inside a card's collapsed detail), but no longer carries sole responsibility for telling the Admin what to do.

No SQL, RPC, or migration changes. No changes to `reportability`/`blocking_reasons`/`exclusion_reasons` semantics — this is presentation-layer only.

## Testing

- `tests/b2c-payment-review-drawer.test.tsx`: replace assertions tied to `primaryActionForRow`/"More actions" with assertions that (a) a record with multiple simultaneous blocking reasons renders one card per reason, all present in the DOM; (b) the first card starts expanded and the rest start collapsed; (c) `failed_payment`/`pending_payment`/`duplicate_exclusion`/`other_open_review` render their "No action needed" tag with no action button; (d) source evidence and audit history are both reachable only through the single closed-by-default disclosure.
- `tests/b2c-payment-decision.test.ts`: unchanged — `explain()`'s contract isn't touched by this design.
- `tests/b2c-stripe-enrichment-dashboard.test.tsx`: update any assertions that depended on the old section layout; evidence-fallback label assertions on the summary are unaffected.
- `tests/b2c-workspace-ui.test.tsx`: update any Work-Queue-to-drawer deep-link assertions that depended on which section auto-opened.

## Full verification

`npx tsc --noEmit` clean, `npx vitest run --no-file-parallelism` all passing, and a live check against the dev server pointed at production data: open a record with a real, currently-unresolved `missing_customer_email` case (e.g. the Arshiya Kherani payment used to verify the prior fallback-display fix) and confirm the new card layout renders correctly, without submitting any real exception or correction during verification.
