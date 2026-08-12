# Tap Statement Upload Design

## Goal

Allow an Admin to upload one complete Tap Statement CSV, preview safe evidence
counts, and explicitly stage every statement line as private original-currency
evidence without creating B2C revenue or modifying provider payments.

## Scope

- Accept one `.csv` Tap Statement export at a time in B2C reconciliation.
- Retain every line: sales, processing fees, fee VAT, refunds, transfers,
  opening balances, and unrecognised lines.
- Store the confirmed original CSV in the existing private
  `b2c-finance-imports` bucket and stage its rows in `b2c_provider_evidence`
  through a new atomic database function.
- Preview only file hash, extracted count, classification counts, missing-ID
  and unparsed-date counts, and a short safe issue summary.

## Non-goals

- No BHD-to-USD conversion, B2C Finance total, published period, automatic
  matching, provider write, or write to `b2c_payments`.
- No removal of fees, VAT, settlement transfers, balances, or unknown lines.
- No assumption that an ambiguous Tap date is a USD reporting date; raw source
  text stays retained until a later audited reconciliation step.

## Input contract

The server accepts a UTF-8 CSV with a header row. Header comparison is
case-insensitive after trimming a possible UTF-8 BOM and whitespace. Required
headers are `postdate`, `txndate`, `description`, `currency`, `debit`,
`credit`, `posting_id`, `charge_id`, and `refund_id`.

The parser retains the full raw header/cell map for each non-blank line and
uses `posting_id` as Tap's immutable statement-row identifier. It classifies
the description using existing rules:

- `Sale -` with a `charge_id`: sale evidence.
- `Fee - Transaction Processing`: processing fee.
- `VAT - Transaction Processing`: fee VAT.
- `Transfer -`: settlement transfer.
- `Opening Balance`: opening balance.
- Non-empty `refund_id`: refund.
- Anything else, or a sale without `charge_id`: needs review.

Tap amounts remain in their original three-letter currency (the supplied
statement is BHD). Credits and debits are validated as non-negative decimals
but never totalled as USD. The source timestamp is retained as raw text; only
an unambiguous parsed timestamp is stored separately. Ambiguous/invalid dates
are an issue, not a rejected statement line.

## Data flow

1. Admin selects a Tap CSV and requests a memory-only preview.
2. The server validates filename, UTF-8 CSV structure, 10 MiB size limit,
   20,000-row limit, required headers, unique non-empty `posting_id`, and
   non-empty statement lines.
3. It classifies all lines and returns safe counts only; it does not write
   Storage or database records.
4. Admin explicitly confirms the same file. The server re-parses and hashes it
   again, rejects a hash mismatch, stores the original file privately, and
   invokes an atomic Tap-evidence finalizer.
5. The finalizer creates one `tap_statement` import and every evidence line in
   one transaction. An identical file hash or Tap provider row ID is rejected.
6. If staging fails after Storage upload, the server attempts to remove the
   just-uploaded object. The page refreshes safe source coverage only.

## Security and controls

- Admin authorization is required before multipart parsing, Storage upload, and
  database finalization. Storage remains private and Admin-only.
- The existing storage bucket gains `text/csv` as an allowed MIME type; `.xlsx`
  remains allowed for Payment Tracker imports.
- Browser code holds only the selected file and safe preview. It receives no
  raw Tap lines, customer/card values, provider IDs, or storage paths.
- Confirmation stays disabled until a successful preview and while a request is
  running. No automatic retry can create a duplicate import.

## UI

Add an Admin-only **Tap statement upload** section below Payment Tracker on the
B2C reconciliation page. It shows filename, extracted-line count, safe kind
counts, missing-charge-ID/unrecognised/date counts, then an explicit **Confirm
staged import** button. It must never show a BHD total, USD conversion, or
reportable revenue claim. Viewers see neither upload control.

## Tests

- CSV parser: BOM/header handling, required headers, full line classification,
  `posting_id` duplication, malformed decimals, row limit, and ambiguous dates.
- API/service: Admin-only access, preview has no writes, confirmation hash
  mismatch, atomic Tap import, private Storage cleanup on finalization failure,
  and no `b2c_payments` write.
- UI: Viewer hides controls; Admin preview/confirmation loading, error, and
  safe-count states; no BHD/USD total is displayed.
- Run focused tests, TypeScript, lint, and production build. Apply the new
  migration manually before first Tap staging.

## Later work

Build the separate Stripe Charges export upload, then construct reviewable
cross-source reconciliation groups. Only a later Finance approval workflow can
publish a verified B2C Finance period.
