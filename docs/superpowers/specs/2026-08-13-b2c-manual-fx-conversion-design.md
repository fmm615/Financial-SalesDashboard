# B2C Manual FX Conversion Design

## Purpose

Retain all valid Stripe and Tap customer-payment evidence even when the provider
currency is not USD, while ensuring PLAYBOOK reports only Finance-approved USD
amounts. Provider data remains read-only: no route, RPC, webhook, or background
job writes to Stripe or Tap.

## Source boundaries

- Stripe and Tap charges are B2C payment evidence; Stripe and Tap refunds are
  separate, linked B2C refund evidence.
- The supplied Tap statement is evidence for the source shape. It contains 230
  `Sale` rows in BHD, plus fees, VAT, transfers, monthly fees, and an opening
  balance. Only successful customer-sale/refund records can become B2C ledger
  candidates. Fees, fee VAT, transfers, balances, and other non-sale statement
  lines are retained only in source evidence and never become B2C revenue.
- A foreign-currency source amount is preserved exactly as supplied. It is not
  converted from a settlement amount, provider balance, or guessed rate.

## Local FX conversion workflow

For a succeeded Stripe or Tap payment/refund whose source currency is not USD:

1. The source record appears in B2C Operations with its original amount and
   currency, plus a `Needs FX review` flag.
2. An Admin may record a local conversion rate, rate source, effective business
   date, and reason. PLAYBOOK calculates the converted USD amount from original
   amount × rate; the Admin cannot type an independent USD figure.
3. The conversion is append-only. A later corrected rate creates a new record;
   the newest approved local conversion is the effective one, while prior rates
   remain in audit history.
4. Saving a conversion resolves only that record's FX-review flag. It never
   clears failed, duplicate, mapping, or missing-data flags.
5. A payment enters USD totals only when it is succeeded, has an effective USD
   amount (provider USD or local conversion), has an approved category or an
   existing permitted Finance exception, and has no unresolved duplicate or
   other blocking source issue. A refund reduces USD totals only after its own
   effective USD amount and the relevant eligibility controls are present.

## Data model and security

- Add append-only payment and refund conversion tables with the linked local
  record ID, original currency, original source amount snapshot, rate,
  calculated USD amount, effective date, conversion source, reason, actor, and
  timestamp.
- Database functions are the sole write boundary. They require an authenticated
  Admin, validate money/date/rate/source/reason, lock the linked source row,
  calculate USD using PostgreSQL numeric arithmetic, resolve only the matching
  FX flag, and write a financial correction/audit event.
- RLS permits approved users to read the safe derived result and permits only
  Admins to invoke the conversion functions. There is no update or delete path
  for a conversion.
- Existing local B2C corrections and Finance exceptions remain local. A Finance
  exception may use a completed local FX conversion but cannot manufacture a
  rate itself.

## Application design

- Tap normalisation stops rejecting valid non-USD customer charges/refunds. It
  stores their original currency and amount with null provider USD values, which
  triggers the existing review mechanism.
- A shared effective B2C payment/refund calculation chooses: local correction
  where permitted, then the latest local FX conversion for foreign currency, or
  the provider USD amount. Reporting never falls back to a provider settlement
  conversion.
- The B2C editor shows a compact `USD conversion required` section for records
  that need FX. It displays the source amount and currency, accepts rate, source,
  effective date, and reason, and previews the calculated USD amount. It does
  not expose any provider-write action.
- B2C Operations and Finance use the same effective calculation. The ledger
  makes the original source amount and local conversion status visible so
  management can trace why a record is or is not in USD totals.

## Error handling

- Invalid provider payloads, unknown source currencies, invalid amounts, and
  incomplete source transactions are recorded as review/integration errors; no
  value is guessed.
- A local FX conversion cannot be saved for a USD source record, a failed or
  pending payment, a missing provider ID, an invalid/non-positive rate, a blank
  rate source, a blank reason, or a missing effective date.
- Database write failures return a safe error to the Admin and leave the source
  record unchanged.

## Verification

- Unit tests cover BHD and USD Tap normalisation, local FX conversion precedence,
  reportability gates, refunds, and no guessed conversion.
- Repository/UI tests verify the B2C ledger shows source currency, calculated
  local USD conversion, and remaining independent flags.
- Migration tests/SQL review verify Admin-only access, append-only conversions,
  audit data, and consistency between dashboard totals and Finance views.
- Run typecheck, lint, relevant tests, and a production build before hand-off.
