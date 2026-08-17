# B2C Finance workspace and ledger-adjustment design

## Goal

Turn the Admin-only B2C Finance page into one focused work queue. An Admin
resolves a payment where it appears, it automatically becomes ready when
eligible, and one controlled action posts all ready Finance payments to the
B2C ledger.

## Scope

- B2C Finance only. B2B data, UI, workflow, and totals remain untouched.
- Replace the long vertically stacked Finance page with internal workspace
  navigation.
- Keep duplicate decisions, Date checks, detail corrections, and posting in
  the same workflow rather than sending an Admin through separate pages.
- Make every displayed payment actionable when an Admin has the authority and
  sufficient evidence to resolve it.
- Add a separate, append-only ledger-adjustment foundation for a correction to
  a Finance payment that has already been posted.

## Workspace navigation

The `/admin/b2c-finance` page keeps its existing Admin route and sidebar link.
Inside the page, a keyboard-accessible tab list provides these focused views:

1. **Work queue** is the default. It explains the one-flow process and shows
   action counts. Each count links to its applicable tab.
2. **Duplicates** shows only unresolved duplicate pairs. The existing
   side-by-side evidence and explicit keep decision remain; a saved decision
   immediately removes that pair from this queue.
3. **Date checks** shows only Date-label conflicts. Each row has its own
   source evidence, reason, and action. There is no blind action that accepts
   every Date at once. An Admin can accept the readable Date only after
   reviewing that row or use the detail-correction control to enter a verified
   date.
4. **Fix details** shows only source rows whose values require verification.
   An Admin sees the original Finance evidence beside inputs for the verified
   values and a required reason. A successful save removes the row from the
   queue.
5. **Ready to post** shows the current count and explanatory eligibility rules,
   then offers the existing idempotent post action. It is the only normal
   posting action; no separate correction-post journey exists.
6. **Posted adjustments** is empty until a Finance payment in the B2C ledger
   needs a later monetary or reporting-date correction. It lists linked
   adjustment history and provides the controlled adjustment action for an
   eligible posted Finance payment.

Tabs preserve the active selection in the URL query string so refresh, back,
and a shared Admin link retain context. On small screens they scroll
horizontally rather than causing the page itself to overflow.

## One-flow behavior

Unposted source rows use the current immutable-workbook model:

1. An Admin reviews the original Finance evidence and saves a reasoned
   duplicate, Date, or detail decision.
2. The source workbook remains unchanged. The effective Finance row reflects
   the verified decision.
3. If the row meets the existing limited iOS/bank-transfer posting rules and
   has no unresolved blockers, it appears automatically in **Ready to post**.
4. One Admin post action creates the provenance-linked B2C ledger payment.

The workspace must explain this outcome locally after every successful action:
the row has been resolved and is now either ready to post or still excluded,
with the reason. A failed request changes neither workbook evidence nor ledger.

## Date and detail decision rules

- Source evidence is always visible before an action: workbook tab/row,
  reported Date, declared Month/Year, amount, customer/contact fields,
  classification, payment method, status, note, and the specific problem.
- A source Date that parses but is implausible for this tracker history (for
  example, year `2922`) is not presented as an automatically acceptable date.
  It requires a verified replacement Date and reason.
- Finance never guesses a day/month order, changes raw workbook cells, or
  treats missing information as zero.
- An unposted amount or business-date correction changes the effective Finance
  row used by the later ledger post. An unposted customer/category correction
  changes only the verified effective representation and audit history.
- Existing duplicate decisions remain pair-specific, append-only, and never
  re-add the excluded workbook copy.

## Posted-ledger correction model

Posted ledger payments are immutable source records. A later Admin correction
does not edit the original payment or workbook row.

### Non-financial details

Name, e-mail, phone, category, and membership corrections use an append-only,
audited local presentation override linked to the existing ledger payment.
The original provider/Finance values remain available in history. These changes
do not create or alter a financial amount.

### Amount and reporting-date corrections

An Admin creates an append-only linked ledger adjustment with a required
reason. The adjustment records the original payment, the original and verified
values, the actor, timestamp, and its reporting date.

- **Amount-only correction:** one signed USD adjustment changes the net
  reported amount while preserving the original payment.
- **Date-only correction:** two linked signed USD adjustments move the amount
  out of the original reporting date and into the verified reporting date. The
  all-time net remains unchanged.
- **Amount and date correction:** a linked reversal for the original reporting
  date plus a linked entry for the verified amount/date produces the correct
  all-time and period totals.

The B2C ledger, dashboard calculations, CSV/report inputs, and future Finance
views must use a single effective-ledger stream: original posted payment plus
approved linked adjustments. The original payment and every adjustment remain
separately visible for audit. Adjustments cannot be deleted, duplicated, or
created for an unresolved/non-USD/unsupported source; the database enforces
the Admin actor, idempotency, and source link.

## Security and audit

- All Finance reads and writes remain Admin-only through the existing
  request-scoped Supabase client, RLS, and protected RPCs.
- The browser receives only the safe, typed source fields already permitted in
  this Admin workspace. Raw provider payloads, card data, and private Storage
  paths are never returned.
- Every decision, correction, and adjustment stores actor, timestamp, original
  values, verified values, and a meaningful reason. No direct browser write to
  a financial table is permitted.
- The original workbook, provider data, and B2B records are never mutated.

## Error handling

- Validation happens on the server and database boundary; invalid amount/date
  combinations receive a specific safe error.
- A failed save leaves the current tab, draft fields, and source evidence in
  place for retry, and clearly states that no data changed.
- Concurrent changes are checked in the database transaction. A stale or
  already-adjusted request returns a reviewable conflict instead of producing
  a second adjustment.

## Tests

- UI tests verify the default work queue, tab selection/deep linking,
  responsive tab semantics, and the single ready-to-post journey.
- Date tests verify that rows are acted on individually and implausible parsed
  dates require an explicit verified replacement.
- Route/service tests verify Admin-only write boundaries, validation, safe
  errors, and queue refresh only after a successful response.
- Database/contract tests verify immutable source payments, append-only linked
  adjustments, idempotency, actor/audit data, period movement, all-time net
  correctness, and no B2B/provider mutation.

## Out of scope

- B2B action-center navigation or B2B financial changes.
- Automatic provider matching or new Stripe, Tap, Apple, or bank integrations.
- Provider writes, raw-source editing, automatic FX conversion, or publication
  of a B2C Finance total before the existing reconciliation gates permit it.
