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

A manual bank transfer is for a genuinely new B2C bank transfer. It is USD-only: the Admin supplies bank reference, customer name, customer e-mail, bank transfer date/time with an explicit offset, USD amount, category, and reason; PLAYBOOK derives the Bahrain business date and stores currency `USD` and exchange rate `1` -- it is never accepted from the browser. Entry runs two checks in order, atomically, inside the confirming write: an exact bank-reference match rejects outright; the standard 48-hour content check (e-mail + amount + category + date) does not reject -- it retains the payment and opens a blocking `possible_duplicate` review flag (through the same generic B2C payment-duplicate-group mechanism every other source uses), excluding it from totals until an audited decision. There is no manual iOS entry path, and no automated iOS/bank-transfer ingestion of any kind exists yet -- the Payment Tracker workbook system that used to fill that gap has been removed in full, and a replacement is pending a new implementation.

### Controlled B2C Finance exception

If essential B2C provider source details are genuinely unavailable, an Admin may include one **succeeded** B2C payment by a documented Finance exception. This is permitted only after confirming the exact unique provider transaction ID, confirming no known duplicate from available evidence, saving verified local amount/date values, and recording a reason. Provider category/tier are optional local metadata for Stripe and Tap payments and are not a Finance-exception prerequisite. The exception is append-only and audited. It never overrides a failed/pending payment, an identified possible duplicate, a missing USD/FX value, or another unresolved source issue; it never changes Stripe or Tap. Manual bank transfers and Finance Tracker rows retain their explicit category requirements.

### Provider product metadata

Stripe and Tap descriptions are retained source evidence and are the visible
product label. A provider category/tier is optional local metadata: a valid
succeeded USD provider payment with `category_code = 'unmapped'` can be
reportable when every other approved rule passes. `unmapped` remains the stable
internal category value in the duplicate fingerprint; free-text descriptions
are never substituted into that fingerprint or normalized into a category.

Historical product mappings, classifications, corrections, and
`unmapped_product` flags remain retained for audit. Mapping is not a live
reportability gate or Admin workflow, and it does not appear as B2C Work-queue
work, a Ledger issue, a generic Review Queue item/filter, or a shared-drawer
action.

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

Support at minimum these live flags:

- Refunded
- Failed
- Possible duplicate
- Needs follow-up

Cleared items remain in history and are not deleted.

`Unmapped product` remains a retained historical flag type for exact audit
inspection only; it is not live work and cannot block reportability.

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
