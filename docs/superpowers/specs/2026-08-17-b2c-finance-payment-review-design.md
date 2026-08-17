# B2C Finance payment review design

## Goal

Give a Finance Admin enough payment evidence to make a B2C workbook decision
without approving blind, while keeping the original workbook immutable and the
current B2C-only scope intact.

## Scope

- Add an administrator-only **B2C Finance** navigation link to the existing
  sidebar under Operations.
- Replace the current blind duplicate batch control with a reviewable,
  selectable duplicate-pair queue.
- Make the underlying workbook facts visible for date-authority and correction
  actions before an Admin saves a decision.
- Do not change B2B, provider data, existing uploaded workbook rows, or the
  ledger-posting rules.

## Recommended workflow

The page uses a hybrid review workflow:

1. The duplicate section lists each exact duplicate pair as one expandable
   review item. It shows B2C and B2C Cons side by side.
2. Each pair shows: source tab and row number, customer name, email, phone,
   Date, amount, category, membership type, payment method, payment status,
   and note. Unavailable values are labelled **Not provided**, never guessed.
3. Differences are visually identified. When one record is objectively more
   complete, the system recommends it and preselects the pair. The Admin may
   deselect it or switch the record to keep before submitting.
4. Tied or structurally unclear pairs are never preselected and require an
   explicit individual choice. They cannot enter a bulk decision by accident.
5. One final confirmation submits every selected pair. The server persists an
   individual audited decision for each pair; the workbook remains unchanged
   and the non-selected copy remains source history only.

## Date and correction evidence

- The Date-authority section displays the source row details, its readable
  Date, supplied Month and Year labels, and the exact conflicting labels.
  Finance can then confirm the readable Date with an audit reason.
- Each correction card displays a source-evidence panel above its editable
  fields. It includes the original customer, contact details, Date, amount,
  category, membership, payment method, status, note, row number, and the
  precise quality issue. Edits create an effective override only.

## Data and security

The existing server repository already has the contact and classification
fields required for duplicate review. It will be extended to return the same
safe Finance evidence for Date and correction rows. The browser receives only
the fields needed for the current Admin decision; no raw provider payload,
card data, or Storage path is exposed.

Existing admin-only routes remain the mutation boundary. Every decision still
requires a reason and records a per-row or per-pair audit event. Selecting an
item changes nothing until the final confirmation succeeds.

## UI and usability

- A compact summary states selected, recommended, and individual-decision
  counts before the confirmation button.
- Each payment pair is collapsed by default after the first few items, with a
  clear **Show payment details** control, so 136 pairs remain navigable.
- The side-by-side table scrolls horizontally on smaller screens rather than
  dropping financial fields.
- Buttons use financial language: **Keep B2C**, **Keep B2C Cons**, and
  **Record selected duplicate decisions**.
- A direct B2C Finance sidebar link is shown only to administrators and uses
  the established navigation styling.

## Error handling and tests

- Empty, malformed, or unavailable evidence is displayed as unavailable and
  does not become an automatic recommendation.
- Failed requests show that no source evidence changed and retain selections
  for retry.
- Tests cover the evidence mapping, preselection eligibility, individual
  override selection, audit-safe payloads, and the admin-only navigation link.
