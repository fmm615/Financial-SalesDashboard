# Tap Ledger Evidence Display Design

## Goal

Make Tap charge evidence visible and unambiguous in B2C Operations without changing Tap, Stripe, HubSpot, or B2C financial reportability.

## Confirmed source facts

- The supplied Tap statement contains 836 ledger rows, all in BHD.
- 230 rows are customer `Sale` rows; the remainder are settlement-ledger rows such as processing fees, fee VAT, transfers, and opening balances.
- Only customer sale/refund candidates may be represented as B2C payments or refunds. Fees, VAT, transfers, and balances must remain evidence only.
- The existing Tap API import retains the customer-charge amount, original currency, and description in the local source metadata. It has 389 imported charges.
- 227 of the 230 statement sale IDs match a local Tap charge ID. Three statement sales have no matching local Tap charge and require a visible Finance reconciliation exception.
- A Tap API charge may be in USD, AED, or BHD while the related Tap statement credit is in BHD. These are different, valid facts: customer-charge currency versus settlement currency.

## Data model and financial safety

The implementation keeps two facts separate:

1. **Customer charge evidence**: original amount, original currency, Tap description, source transaction ID, and payment status from Tap API.
2. **Settlement evidence**: statement description, BHD credit/debit, fee, VAT, transfer, or balance entries from the uploaded Tap statement.

The implementation must not replace an original customer currency with BHD, infer a USD amount from BHD settlement data, create a B2C payment from a fee/VAT/transfer/balance line, or change reportability. Non-USD source activity remains outside USD reporting until an Admin saves the approved, append-only local FX conversion.

## User interface

The B2C source ledger will display for all providers:

- Reporting amount, with the existing USD-reporting/FX-review treatment.
- Original source currency in its own `Currency` column.
- Provider description in a `Description` column. For Tap this is the retained Tap charge description; for Stripe it remains the approved Stripe evidence description.

The table uses safe generic source fields rather than Stripe-only data so Tap rows no longer show an empty description merely because they are not Stripe rows.

## Reconciliation exceptions

The three statement-only sale IDs remain retained source evidence and are surfaced as Tap reconciliation exceptions. They are not invented as API payments and have no Finance total impact until Finance links/reviews them through the existing controlled reconciliation boundary.

## Error handling and access

All data remains read-only from Tap. The display change has no external API writes and no database migration: the required Tap values are already stored. Existing server-side Admin-only controls and RLS continue to govern corrections, FX conversions, and finance exceptions.

## Tests

Add a repository/unit regression test that demonstrates a Tap payment's metadata description and original currency become safe B2C ledger fields, while the existing Stripe evidence description remains displayed. Test that source fields do not affect USD reportability.

