# Payment Tracker Upload Design

## Goal

Let an Admin upload one Finance Payment Tracker `.xlsx` file, preview its
staged B2C rows, and explicitly confirm the import without creating reportable
revenue or changing existing B2C provider records.

## Scope

- Accept one `.xlsx` file at a time in **B2C reconciliation**.
- Read exactly the `B2C` and `B2C Cons` worksheets.
- Store the confirmed original file in a private Supabase Storage bucket and
  stage its rows through the existing atomic Finance-import function.
- Show a non-financial preview: source hash, accepted tabs, extracted-row count,
  valid/zero/needs-review/invalid counts, date conflicts, and exact/possible
  duplicate candidates within the workbook.
- Keep Tap CSV and Stripe Charges uploads out of this change. They are separate
  evidence-upload features and remain required for later verification.

## Non-goals

- No B2C Finance revenue total, published period, automatic Finance approval,
  or write to `b2c_payments`.
- No automatic correction of a date, month label, amount, customer identity, or
  duplicate decision.
- No processing of arbitrary workbook tabs, `.xls`, CSV, macro-enabled files,
  password-protected files, or files above the configured size limit.

## Chosen approach

The application parses the workbook on the server, not in the browser. A
preview request reads the file only in memory and returns a safe summary. On
explicit confirmation, the user submits the same selected file again; the
server recomputes its SHA-256 and rows, checks that the preview hash still
matches, saves the original file into private Storage, and invokes the existing
atomic `finalize_b2c_finance_import` database function.

The double parse is deliberate. The server never trusts rows or totals sent by
the browser, and a changed file cannot be confirmed as if it were the reviewed
file. If database finalization fails after Storage upload, the route attempts
to remove the just-uploaded private object and returns a safe error. A unique
database file hash still prevents the same confirmed file from being imported
twice.

## Data flow

1. Admin selects a file and requests a preview.
2. The server checks file type, filename, size, ZIP/XLSX structure, and only
   accepts the two specified sheet names once each.
3. A server-side spreadsheet parser reads displayed cell values, maps the
   known per-tab headers into raw Finance row fields, and retains the original
   cell map for every accepted row.
4. Existing Finance validation assesses each extracted row. The preview returns
   only summary counts, issue counts, source hash, and a short sample of issues;
   it never returns every customer record to the browser.
5. Admin reviews the result and presses **Confirm staged import**.
6. The server re-parses the selected file, verifies its hash against the preview
   hash, writes the source file to private Storage, and finalizes all rows
   atomically. No reportable payment is created.
7. The page refreshes its safe coverage summary and tells the Admin that the
   source remains non-reportable until Stripe, Tap, reconciliation, and Finance
   approval are complete.

## Spreadsheet mapping

The parser reads header labels case-insensitively after trimming whitespace.

| Staged field | `B2C` accepted header | `B2C Cons` accepted header |
| --- | --- | --- |
| date | `Date` | `Date` |
| amount USD | `Amount USD` | `Amount` |
| customer name | `Name` | `Name` |
| phone | `Mobile` | `Mobile` |
| category | `Type` | `Category` |
| membership type | — | `Membership Type` |
| payment method | `Pay Method` | `Pay Method` |
| payment status | `Payment Status` | `Payment Status` |
| month / year | — / `year` | `Month` / `Year` |
| notes | `Note` | `Note` |

The `B2C` tab has no membership-type column; the parser leaves that source value
unknown. Headers must be present for date, amount, name, and payment method.
Missing required headers reject the file rather than guessing a column.

## Security and error handling

- Admin authorization is checked in every upload route and enforced again by
  Storage policy and database RLS.
- The private bucket accepts only Admin insert/delete and never anonymous or
  viewer reads.
- Workbook bytes are parsed only in a Node.js route. Inputs have a modest,
  documented maximum size and row cap to protect the server.
- The parser rejects formulas as source values if no calculated displayed value
  is present; it never evaluates a workbook formula itself.
- Source names and errors are sanitized. No raw customer payload, provider ID,
  or Storage path is returned to viewers.
- Confirmation is enabled only after a successful preview. The button disables
  while processing to prevent accidental double submission.

## Test plan

- Parser tests: supported tabs/headers, mapped fields, repeated headers,
  invalid/missing tab, too many rows, displayed values, and safe formula
  handling.
- API tests: unauthenticated/viewer rejection, file validation, preview without
  persistence, confirmation hash mismatch rejection, atomic-finalization call,
  Storage cleanup on failure, and no `b2c_payments` write.
- UI tests: upload controls only for Admin, loading/error/preview states,
  confirmation disabled without preview, and no B2C Finance revenue total.
- Run the full application test suite, TypeScript, lint, and production build.

## Later work

Add a dedicated Tap CSV parser/upload and a dedicated Stripe Charges export
parser/upload. Then construct cross-source reconciliation groups and implement
a Finance period-approval workflow. Only that later workflow may make a B2C
Finance period reportable.
