# Approved Finance Payment Ledger Design

**Date:** 17 August 2026  
**Status:** Approved for implementation  
**Scope:** Post approved iOS and bank-transfer Payment Tracker records into the B2C ledger without re-importing, altering, or double-counting source evidence.

## Decision

The Finance team has already approved the iOS and bank-transfer entries in the
staged Payment Tracker. They do not need an additional per-row Finance approval
workflow.

The dashboard will provide one Admin-only, idempotent **Post approved Finance
payments** action. It creates B2C ledger payment records only for valid staged
rows whose normalized payment method is `ios` or `bank transfer`. The source
rows remain immutable and the original workbook remains the evidence.

## Why this is a separate ledger source

iOS and bank-transfer payments are not Stripe or Tap payments:

- a bank transfer normally has no processor record to match;
- an iOS membership entry is a row-level Finance record, while the supplied
  Apple proceeds information is aggregate and cannot prove an individual row;
- the Payment Tracker records are stated by Finance as gross revenue excluding
  VAT, in USD.

They therefore enter the ledger with `source_system = 'finance_tracker'` and a
retained `finance_payment_method` of either `bank_transfer` or `ios`. They are
shown as **Finance — Bank transfer** or **Finance — iOS**, never as Stripe or
Tap. A provider reference is intentionally absent.

## Eligibility and duplicate protection

A row can be posted only when all of the following are true:

1. it belongs to a completed `payment_tracker` import;
2. it has `row_quality = 'valid'`, a positive USD amount, a parsed business
   date, and a supported normalized payment method;
3. it has a source category that can be deterministically normalized to the
   dashboard category-code format; and
4. it is not already linked to a posted Finance-ledger record.

Rows with an exact duplicate-reconciliation group are handled as follows:

- `canonical`: only the selected canonical Finance row may post;
- `excluded`: no row in the group may post;
- undecided or non-canonical duplicate state: no row in the group may post.

This preserves the rule that an identical `B2C` and `B2C Cons` record is one
payment, not two. Invalid, zero-value, missing-date, missing-name, unsupported
method, or unnormalizable-category rows remain staged evidence and are never
silently repaired or posted.

## Ledger values and contacts

For each eligible source row, the post creates one succeeded USD B2C payment:

- `original_amount`, `amount_usd`, and `gross_amount_usd` equal the staged
  Finance `amount_usd`;
- `original_currency` is `USD` and the exchange rate is `1`;
- `tax_amount_usd` and `net_amount_usd` remain null because the supplied
  tracker amount is already Finance’s gross revenue excluding VAT, not a Tap
  or Stripe settlement calculation;
- `occurred_on` is the staged business date and `occurred_at` is that date at
  UTC midnight solely because the sheet has no verified time of day;
- name, e-mail, and phone are copied exactly from the staged source columns,
  if present; they are displayed as Finance-source contact evidence;
- category and membership type are copied/normalized from the staged fields;
- source tab, source row number, import ID, payment method, raw category, and
  source amount basis are preserved as non-reporting source metadata.

No amount is inferred from Apple aggregate proceeds, Stripe, Tap, a name, or a
contact detail. A missing contact remains missing; it is not replaced with a
placeholder.

## Approved-reporting behavior

The posting action is the authenticated Admin’s audited confirmation that these
valid Finance entries are approved B2C payment records. Once posted, they are
eligible for the B2C ledger/reportability gate even when an e-mail is absent.
This exception is deliberately limited to rows with immutable Payment Tracker
provenance and a Finance-ledger post; it does not weaken Stripe or Tap missing
e-mail controls.

The action does not publish a report, send an email, modify Stripe, Tap, or
Apple, or change the raw spreadsheet data. It merely adds the approved payment
records to the B2C ledger, where the usual dashboard date filters and audit
history apply.

## Persistence, audit, and access

`b2c_finance_ledger_posts` will link one staged Finance row to one ledger
payment, with the Admin actor and timestamp. Its one-to-one constraints make
the operation safe to repeat after a browser retry. The protected database
function is the only bulk-post write path. It verifies `auth.uid()` and
`is_admin()`, locks the selected source rows, creates an audit event, and
returns counts for posted and skipped rows.

Only Admins see the action and its safe summary. Viewers do not receive source
contacts, raw workbook data, or posting controls. Database RLS remains the
enforcement boundary.

## User experience

The B2C reconciliation page changes from “Finance revenue is not published” to
a clear staging summary plus an Admin card:

- **Post approved Finance payments**
- “Adds valid iOS and bank-transfer rows to the B2C ledger. It does not create
  Stripe/Tap payments or change the spreadsheet.”
- a results message such as “18 Finance payments added; 4 were already in the
  ledger; 2 were held because of duplicate decisions or invalid source data.”

The B2C Operations ledger shows them with Finance source labels and existing
customer columns. It never claims a Stripe/Tap match for those rows.

## Failure handling

- The post runs transactionally; a failure posts no partial batch.
- A retry returns the authoritative result and cannot create a second ledger
  payment for the same Finance row.
- Source or duplicate-decision inconsistencies are counted as safely skipped,
  not treated as zero and not automatically fixed.
- User-facing errors remain generic and do not expose raw Payment Tracker data.

## Verification

- Unit tests cover supported methods, category normalization, Finance-source
  contact display, and reportability with/without immutable Finance provenance.
- Repository/API tests cover Admin-only access, the single RPC call, safe
  result mapping, and no provider writes.
- UI tests cover Admin posting controls, safe result text, Finance source
  labels, and absence of controls for viewers.
- Database contract tests assert the Admin guard, one-to-one provenance,
  canonical duplicate requirement, and absence of Stripe/Tap writes.
- Full tests, typecheck, lint, production build, and `git diff --check` run
  before the implementation is handed over. The user applies the migration
  manually in Supabase.

## Non-goals

- Backfilling any Stripe, Tap, Apple, or B2B record.
- Treating Apple aggregate proceeds as individual sale evidence.
- Reconciling the three source files; that remains the next reconciliation
  workspace feature.
- Posting any tracker method other than iOS or bank transfer in this release.
- Correcting, deleting, or replacing staged Finance evidence.
