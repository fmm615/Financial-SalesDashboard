# Approved Business Rules

These rules come from the PLAYBOOK Sales & Reporting Dashboard requirements and must carry over to the rebuild.

Do not reinterpret them without explicit approval.

## B2C

- All Stripe sales are B2C. Always.
- Stripe must never create a B2B deal.
- Tap provides B2C payments.
- Approved bank-transfer entries may be recorded manually as B2C.

## B2B

- B2B pipeline and bookings come from HubSpot or approved manual Finance entry.
- HubSpot is the source for corporate pipeline stages and bookings unless Finance decides a deal should be entered manually.

## Separate financial concepts

Keep these concepts distinct:

- pipeline
- bookings
- invoiced amount
- cash received
- recognised sales/revenue

A signed/closed-won B2B deal is a booking dated by its HubSpot close date.

Bookings and recognised sales are different numbers.

Show both clearly and never add them together as though they are the same thing.

## Duplicate prevention

Every record must pass two duplicate checks before being counted:

1. Provider/processor transaction ID check.
2. Content fingerprint check based on email + amount + category + date against records from the previous 48 hours.

This must protect webhook processing and reconciliation from double counting the same transaction.

### Manual bank-transfer entry

A manual bank transfer is for a genuinely new B2C transfer not already present in Payment Tracker. It is USD-only: the Admin supplies bank reference, customer name, customer e-mail, bank transfer date/time with an explicit offset, USD amount, category, and reason; PLAYBOOK derives the Bahrain business date and stores currency `USD` and exchange rate `1` -- it is never accepted from the browser. Entry runs three checks in order, atomically, inside the confirming write: an exact bank-reference match rejects outright; an exact match against a posted or unposted Payment Tracker `bank_transfer` lineage also rejects outright and links to the existing record, because a sheet bank transfer is never re-entered manually; the standard 48-hour content check (e-mail + amount + category + date) does not reject -- it retains the payment and opens a blocking `possible_duplicate` review flag, excluding it from totals until an audited decision. The same write reserves the payment's own Finance source-identity, so a later Payment Tracker workbook recognizes it and can only link evidence, never repost it. There is no manual iOS entry path.

### Controlled B2C Finance exception

If essential B2C provider source details are genuinely unavailable, an Admin may include one **succeeded** B2C payment by a documented Finance exception. This is permitted only after confirming the exact unique provider transaction ID, confirming no known duplicate from available evidence, saving a verified local PLAYBOOK category/amount/date, and recording a reason. The exception is append-only and audited. It never overrides a failed/pending payment, an identified possible duplicate, or another unresolved source issue; it never changes Stripe or Tap.

## Refunds

Refunds are recorded, never deleted.

A refund is a separate entry linked to the original payment.

The original payment remains untouched in the ledger.

## Currency

B2B and B2C reporting is in USD.

If a source record uses another currency, preserve the original currency and source amount for audit purposes. Never invent a USD value from a provider settlement rate. It remains outside USD reporting until Finance approves a conversion source and accounting rule.

For a B2C foreign-currency provider payment or refund, that approval is a separate, append-only local FX conversion. An Admin records the USD-per-unit rate, source of the rate, effective date, and reason; PLAYBOOK calculates and retains the USD reporting amount locally. A normal local correction cannot enter a USD amount for a foreign provider record. The conversion never updates Stripe, Tap, or the source row.

## Missing data

Empty is not zero.

If historical data has not been backfilled, show it as unavailable/not loaded rather than `$0`.

## Manual changes

Every manual financial change must record:

- user
- timestamp
- before value
- after value

The system must be able to answer: "Who changed this and when?"

## Review queue

Support at minimum these flags:

- Refunded
- Failed
- Possible duplicate
- Unmapped product
- Needs follow-up

Cleared items remain in history and are not deleted.

## Reports

Support:

- monthly reports
- quarterly reports
- annual reports
- on-demand reports for selected date ranges

Every report contains:

- branded PDF
- CSV bundle of underlying rows
- archived downloadable copy
- email delivery when requested/approved

Do not automatically send reports until report generation and financial totals have been proven reliable.
