# B2C Finance Workbook and Tap Reconciliation Design

## Goal

Create a controlled B2C import foundation that can ingest Finance workbook
rows and Tap statement evidence without double counting, guessing dates,
inventing FX, or publishing a financial total before Finance approves the
reconciliation.

## Confirmed sources and meanings

Only these workbook tabs are in scope for the first Finance import:

- `B2C`
- `B2C Cons`

Both contain Finance's B2C revenue amount in USD, gross of the sale and
excluding customer VAT. They may overlap. Neither tab is automatically the
primary ledger or an extra total.

The separate Tap statement contains BHD payment evidence. Each customer sale
is identified by `charge_id` and has one linked processing-fee row and one
linked VAT-on-fee row. Tap transfers and opening balances are not sales.

The separate Stripe Charges export is payment evidence: gross paid including
customer VAT, Stripe fee, and processor cash movement. Its complete source file
is required before any period using Stripe can become verified. It is not part
of this first implementation because only a sample has been received.

## Financial treatment

The canonical B2C reporting amount is the Finance workbook's USD revenue
excluding VAT. Provider charges, fees, VAT on provider fees, and payouts are
stored as reconciliation evidence and never added to the Finance revenue total.

The system keeps these concepts separate:

- customer gross including VAT;
- customer VAT;
- revenue excluding VAT;
- processor fee and VAT on that fee; and
- provider net cash movement or actual payout.

No code derives a Tap BHD-to-USD rate. Tap retains its BHD values for audit;
the later link to a Finance revenue row is a reconciliation relationship, not
an FX conversion.

## Import boundary

Uploaded files first enter an immutable staging area. Every staged row retains:

- import file ID, SHA-256 content hash, original file name, and import time;
- workbook tab name and one-based source row number, where applicable;
- raw source cells or row payload;
- normalized fields used only for comparison; and
- validation and reconciliation statuses.

Re-importing an identical file hash is rejected. A changed file is a new import
and cannot overwrite prior staging rows or decisions.

No staged row writes directly to `b2c_payments`. A period stays `not_fully_loaded`
until every required provider source is present and Finance has approved the
reconciliation result.

## Finance workbook normalization

`B2C` and `B2C Cons` use different column names. The importer maps their data
to a shared Finance-row model: source tab/row, name, email-or-mobile,
reported date, amount USD, category, membership tier, payment method, note,
payment status, and declared year/month.

Rows with zero amount are staged and labelled as zero-value exceptions. They
do not become revenue. Blank payment status, blank payment method, blank
customer identity, or missing amount is retained and flagged rather than
defaulted.

Date handling is deliberately conservative. The current workbook contains
mixed Excel serial and text dates, unparseable dates, and `B2C Cons` month
labels that conflict with stored dates. The importer preserves all original
date/month/year cells. It does not swap day/month values or use a month label
to rewrite a date. A conflict becomes an Admin/Finance review item with a
required evidence note.

## Duplicate and match controls

The process has three separate outcomes; none deletes a source row.

1. **Exact duplicate candidate**: same normalized customer identity, reported
   date, USD amount, payment method, and where available category/tier. The
   group may be proposed for a single canonical Finance sale.
2. **Possible duplicate**: overlapping identity, amount, method, and nearby
   date but an absent or conflicting value. It requires an explicit review
   decision.
3. **Conflict**: same likely sale but incompatible date, amount, payment
   method, category, or membership tier. It cannot be automatically linked or
   counted.

Matching uses email first when available, then a normalized name plus one
additional field. Name and amount alone are never enough because recurring
memberships can legitimately have equal payments.

An approved canonical Finance sale can have multiple source rows as evidence,
but it has exactly one reportable revenue amount. The decision must retain the
Admin actor, timestamp, chosen source row, reason, and before/after values.

## Provider evidence

Tap imports group rows by exact `charge_id`:

- one `Sale - ...` row is the provider payment;
- one processing-fee row and one VAT-on-fee row are linked costs; and
- no transfer/opening-balance row can become a sale.

The Tap statement has no refunds in the supplied file. The schema remains able
to retain a future refund as a distinct linked evidence row.

Later Stripe imports group by exact Charge ID (`ch_...`), preserve succeeded,
failed, and refunded states, and link refunds without rewriting the original
charge. Provider-to-Finance matching is evidence only. A provider row never
creates a second Finance revenue sale.

## Coverage and publication gate

For each month, the reconciliation result exposes the count and amount of:

- canonical Finance sales;
- exact duplicates suppressed from totals;
- possible duplicates;
- conflicts and invalid dates;
- unmatched Finance rows;
- unmatched Tap/Stripe provider rows; and
- missing required source files.

Only a Finance-approved period with no unresolved blocking exception can be
marked `verified`. All other periods show `not_fully_loaded` or `needs_review`
in dashboards, targets, reports, and alerts. Missing data is never zero.

## Security and operations

An Admin uploads, previews, resolves, or approves an import through
request-scoped authenticated routes. RLS and database audit triggers enforce
the write boundary. Viewers may see only UI-safe reconciliation summaries, not
raw payment-provider payloads or unnecessary personal data.

Long-running parsing and matching use durable import-job states: `pending`,
`processing`, `completed`, and `failed`. Failures retain a safe diagnostic and
do not partially publish records.

## Tests

Tests must prove that:

- the same file hash cannot create a second import;
- only the two approved workbook tabs are accepted;
- malformed dates and blank statuses are flagged rather than repaired;
- a Finance duplicate cannot add revenue twice;
- a possible duplicate or conflict is excluded until an audited decision;
- Tap fees, fee VAT, transfers, and opening balances cannot become revenue;
- two Tap sales cannot share a `charge_id`;
- a BHD Tap amount is never converted without an approved FX source; and
- incomplete source coverage keeps financial totals unavailable.
