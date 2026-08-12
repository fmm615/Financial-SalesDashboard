# Stripe Charges CSV Upload Design

**Date:** 12 August 2026  
**Status:** Approved for planning  
**Scope:** Historical Stripe Charges CSV as B2C provider evidence

## Goal

Let an Admin preview and atomically stage a complete Stripe Charges CSV as
private, traceable B2C payment evidence. The import must help reconcile Finance
Payment Tracker rows without creating a second revenue ledger or a reportable
B2C total.

## Source format and scope

The expected input is the standard Stripe Charges CSV represented by the
provided sample. Header names are normalized for spacing and case; additional
Stripe columns are tolerated and never interpreted as financial rules.

The importer requires these headers:

- `id`
- `Created date (UTC)`
- `Amount`
- `Amount Refunded`
- `Currency`
- `Captured`
- `Fee`
- `Mode`
- `Status`

It reads these optional contact fields when present:

- `Card Name`
- `Customer Description`
- `Customer Email`
- `Customer Phone`

It does not surface card numbers, card fingerprint, card/address fields,
payment-method IDs, IP addresses, metadata, or other raw exported values. The
private original source file retains full evidence for authorised audit access.

## Accepted rows and classification

Every non-blank CSV row creates one primary evidence entry, using its Stripe
charge ID as the provider row ID when one is present. A row with a positive `Amount Refunded`
creates one additional, linked refund evidence entry from the same source row.
The schema therefore adds an explicit source-entry key (`primary` or `refund`)
to its immutable provenance key; it does not invent a Stripe refund ID where
the Charges export does not provide one. Both entries retain the charge ID,
original source-row number, original status, and raw cells.

Duplicate non-empty charge IDs in one source file are rejected. An existing
Stripe provider row and source-entry key, or an exact source-file hash, is
rejected atomically.

Rows are classified from direct Stripe values:

- `Paid` with a non-empty charge ID and captured `TRUE` becomes `sale` evidence.
- A positive `Amount Refunded` creates separate `refund` evidence linked to
  the charge ID; the original paid evidence remains unchanged.
- `Failed`, `canceled`, uncaptured, missing-ID, malformed, or unrecognised rows
  become `needs_review` evidence.
- `Fee` is retained in that charge row's raw source payload only when it can be
  tied directly to a valid charge ID. It is not a revenue deduction, a second
  provider-evidence row, or a dashboard total. The source-entry key makes the
  primary charge and its optional linked refund independently immutable.

The parser retains the original Stripe status and a deliberate non-sensitive
source-field subset, so a Finance reviewer can see why a row was classified
without guessing from description text. Card, address, fingerprint, IP,
payment-method, and metadata fields remain only in the private original file,
not in the evidence-table payload.

## Currency and amounts

The import retains original currency, original amount, refunded amount, and
fee evidence. It never uses `Converted Amount` or `Converted Currency` as USD
financial values: the supplied export shows AED conversions, which are not a
Finance-approved USD rate.

Only a later Finance-approved reconciliation decision may support a USD
Finance Payment Tracker row. Non-USD rows remain original-currency evidence;
the importer will not make a BHD, GBP, AED, or other currency conversion.

## Contacts and access

The evidence schema adds separately validated, optional customer-name,
customer-email, and customer-phone columns. The Admin B2C review experience
displays the best direct source values for
customer name, email, and phone. It uses a clear source priority: customer name
comes from `Card Name`, falling back to `Customer Description`; email and phone
come only from their direct Stripe columns. Blank values remain blank.

Approved Viewers and the Executive dashboard receive aggregate source coverage
only—never individual names, email addresses, phone numbers, charge IDs, raw
rows, or source files. This keeps operational contact details available to the
team that resolves records without making them part of management reporting.

## Flow

1. An authenticated Admin selects one CSV, up to 10 MiB and 20,000 non-blank
   data rows.
2. The server parses it in memory, validates required headers/IDs/statuses and
   returns safe counts only: total rows, paid/refunded/failed-or-review rows,
   rows with direct contact information, unsupported-currency rows, and
   duplicate candidates. It returns no amounts, contacts, IDs, or raw rows.
3. The Admin explicitly confirms the same SHA-256 source file.
4. The original CSV is uploaded to the existing private
   `b2c-finance-imports` Storage bucket.
5. One protected database function creates the `stripe_charges` import and all
   Stripe evidence entries in a single transaction, including both linked
   entries for a refunded source row. Storage is removed if that database
   operation fails.
6. The B2C reconciliation page refreshes only safe source coverage. The page
   remains `Not fully loaded` until reconciliation and a separate Finance
   approval workflow exist.

## Non-goals

- No writes to `b2c_payments`, B2B tables, totals, targets, or reports.
- No automatic matching, canonical decision, reconciliation-group creation, or
  Finance approval.
- No live Stripe API call, webhook change, or historical API backfill change.
- No customer contact details in Viewer, Executive, report, or preview output.
- No inferred product, membership, category, date correction, or currency rate.

## Failure handling

- Reject wrong extension, invalid/missing headers, malformed CSV, duplicate
  source IDs, invalid decimal values, and sources beyond the stated limits.
- Reject a confirmation if the file hash differs from the preview.
- Keep raw sources private; browser errors return only a safe explanation.
- A completed source hash cannot be staged again. A failed atomic finalization
  removes the uploaded object, so it cannot leave partial provider evidence.
- The interface must always clear its loading state after a response. If a
  network response is interrupted after the atomic database transaction,
  refreshing shows the authoritative coverage status; retrying cannot create a
  second import because of the source-hash constraint.

## Verification

- Pure CSV parser tests: header tolerance, paid/refunded/failed classification,
  raw currency retention, direct-contact extraction, invalid row rejection,
  duplicate charge rejection, size and row limits.
- Service/route tests: Admin-only access, preview no-write guarantee, hash
  mismatch rejection, private Storage cleanup, and atomic RPC invocation.
- UI tests: Admin two-step flow and safe preview; Viewer cannot see upload
  controls or contact details; no amount total, conversion, or revenue claim.
- Database test: protected finalization exists, preserves the explicit source
  entry key for refunds, protects contact fields with Admin-only RLS, and leaves
  `b2c_payments` untouched.
- Full project test suite, TypeScript, lint, and production build before each
  code checkpoint. The local Supabase CLI remains unavailable, so database
  pgTAP coverage is retained for manual/CI execution.
