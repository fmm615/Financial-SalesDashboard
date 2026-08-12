# Stripe Read-Only Enrichment Design

## Purpose

Improve the completeness of Stripe B2C records by reading the same useful
Stripe objects that contribute to the Stripe Charges export. The integration
must remain technically incapable of creating, editing, refunding, deleting,
or otherwise changing anything in Stripe.

The enriched API record and an uploaded Stripe CSV row with the same Charge ID
represent one payment. Enrichment must never create a second sale.

## Confirmed cause of the missing data

The current integration reads contact values from the Charge's
`receipt_email`, `billing_details`, and `shipping` fields. It optionally follows
the PaymentIntent to Checkout line items for a Price and Product, but it does
not read the other objects used by the Stripe export.

The supplied Stripe Charges sample contains useful values from several sources:

- `Card Name` and Card ID can be backed by the transaction's Payment Method.
- `Customer Description`, `Customer Email`, and `Customer Phone` come from the
  Stripe Customer profile used by the export.
- Invoice and Checkout identifiers provide transaction and product context.
- Fee, converted amount, converted currency, and net settlement information are
  backed by the Charge's Balance Transaction.

Therefore a CSV row can contain a customer name, email, or phone while the
current Charge-only normalizer stores `NULL`. This is an incomplete read path,
not evidence of a second payment.

## Approaches considered

### Keep the Charge-only integration

This preserves the strongest transaction-only semantics but knowingly leaves
records less complete than the Stripe export. It does not meet the requested
future automation goal.

### Copy the current Customer profile into the payment

This most closely resembles the visible CSV, but a Customer profile can change
after an older payment. Treating it as transaction-time evidence could alter
duplicate detection or make a payment reportable using data that was not
captured with that transaction. This approach is rejected.

### Layer transaction enrichment and labelled mutable fallbacks

This is the selected approach. Read transaction-linked Stripe objects first.
Store current Payment Method and Customer-profile contact separately as
display/reconciliation context. Only transaction-linked contact evidence may
populate the payment's financial matching fields automatically. The labelled
fallback can make the dashboard more useful without silently changing
financial eligibility.

## Read-only Stripe boundary

The Stripe client continues to expose explicit read methods implemented only
with HTTP `GET`. It will have no generic public request method and no Stripe
method capable of `POST`, `PATCH`, `PUT`, or `DELETE`.

The enrichment path may read:

- Charge
- Payment Method referenced by the Charge
- Checkout Session associated with the PaymentIntent
- Checkout Session line items
- Invoice referenced by the Charge
- Invoice line items or their direct Price/Product references
- Customer referenced by the Charge, Checkout Session, or Invoice
- Balance Transaction referenced by the Charge
- Refund objects through the existing refund path

All responses remain untrusted until validated by focused Zod schemas. Failed
optional enrichment must not discard an otherwise valid Charge. It must be
recorded safely with the Charge reference and remain available for retry.

The application never logs authorization headers, secrets, raw Stripe payloads,
or unrestricted provider error bodies. Live verification must use rotated
credentials after the previously displayed credentials are replaced.

## Contact evidence and precedence

The system distinguishes transaction evidence from mutable provider context.

### Transaction-linked sources

For each field, use the first valid non-empty value in this order:

1. Charge receipt, billing, or shipping details.
2. Completed Checkout Session `customer_details`.
3. Finalized Invoice customer snapshot fields.

The chosen field retains a source label such as `charge_receipt`,
`charge_billing`, `charge_shipping`, `checkout_session`, or
`invoice_snapshot`. Validated transaction-linked email may satisfy the existing
verified-source-email gate.

### Mutable provider fallback

If every transaction-linked source is empty, the integration may retain the
current Payment Method billing details and Customer profile's name, email, and
phone in a separate Stripe-details record. Both Stripe objects can be edited
after an older payment, so neither is treated as proof of the contact captured
at the time of that transaction. The B2C dashboard may display the first valid
fallback with a `Stripe profile` or `Stripe payment method` label, but it does
not:

- replace the payment's transaction contact fields;
- satisfy the verified transaction email gate;
- change the payment's duplicate fingerprint;
- resolve a missing-contact review item automatically; or
- overwrite a verified local correction.

This reproduces the useful context visible in the Stripe export without
claiming that a mutable provider value existed when an older payment occurred.

### Conflicts

A later source never silently overwrites a different non-empty value from a
higher-priority source. The retained alternatives and their source labels are
available to an Admin. Material contact conflicts create or retain a
`needs_follow_up` review flag.

## Financial and product evidence

The Charge remains authoritative for its provider ID, gross charged amount,
currency, status, capture state, timestamp, and refund linkage.

The Balance Transaction may add original settlement evidence:

- settlement gross amount and currency;
- Stripe fee and fee-detail breakdown;
- net settlement amount;
- Stripe-provided exchange rate when present; and
- availability/status context.

These values are reconciliation evidence. They do not replace Charge gross
sales, create revenue, or establish a Finance-approved currency conversion.
Unknown fee, tax, net, or conversion values remain `NULL`, never zero.

Checkout or Invoice line items may add stable Price and Product references,
plan name, and billing interval. A configured Charge metadata reference remains
first priority. One unambiguous priced item may be mapped through the existing
approved product-mapping workflow. Multiple distinct priced items remain
unmapped until Finance approves an allocation rule.

Stripe tax totals may be retained only when directly stated on the completed
Checkout Session or Invoice. Metadata strings and arithmetic differences are
not accepted as verified tax. This feature does not subtract VAT or publish
net-of-VAT revenue.

## Local persistence

`b2c_payments` remains the one-row-per-provider-payment ledger protected by the
existing unique Stripe Charge ID. Transaction-linked enrichment may fill a
previously missing payment contact or product reference, but a partial webhook
or failed optional lookup must never replace a retained non-empty value with
`NULL`.

A focused one-to-one Stripe payment-details table will retain only the approved
typed enrichment fields needed for traceability and reconciliation, including:

- payment, PaymentIntent, Payment Method, Checkout Session, Invoice, Customer,
  and Balance Transaction identifiers;
- selected contact-source labels;
- current Payment Method and Customer-profile fallback contacts;
- settlement gross, fee, fee tax, net, currency, and exchange-rate evidence;
- directly stated Stripe tax evidence; and
- last successful enrichment timestamp.

The table stores no card number, last four digits, fingerprint, expiry,
address, IP address, UTM values, or unrestricted raw payload. It is Admin-read
only and uses database constraints for money, currency, field lengths, one
details row per payment, and a Stripe-only linked payment. A protected
approved-user function exposes only the resolved mutable fallback contacts and
their labels; it exposes no provider IDs, settlement, tax, issues, or timestamps.

Local Admin corrections remain separate and keep priority in effective
dashboard presentation. Automated enrichment records provider facts; it is not
a manual correction and does not manufacture an Admin audit actor.

## Ingestion flow

For a webhook, 48-hour reconciliation item, or historical-backfill Charge:

1. Validate and normalize the Charge.
2. Read only the referenced optional objects needed for missing or approved
   enrichment fields.
3. Validate each optional response independently.
4. Resolve transaction contacts according to the fixed precedence.
5. Retain mutable Payment Method and Customer-profile context separately.
6. Persist the Charge idempotently by exact Charge ID.
7. Upsert the one Stripe-details record locally.
8. Recompute local duplicate and review state only from approved transaction
   evidence and mappings.
9. Record safe per-object lookup failures without losing the valid payment.

The historical backfill revisits existing Charge IDs and enriches them in
place locally. Re-running a page is safe: the Charge unique key and one-to-one
details constraint prevent duplicate payments and duplicate details records.

## Dashboard behavior

The B2C ledger continues to show one row per Stripe Charge. Through the narrow
fallback-contact function, it displays:

- effective name, email, and phone;
- a subtle source label when a displayed contact comes only from a current
  Stripe Payment Method or Customer profile;
- existing payment amount, status, date, category, and product context; and
- Admin-only settlement evidence where useful for reconciliation.

Mutable fallback improves identification but does not remove the existing
missing transaction-email exclusion. The calculation breakdown and reportable
totals continue to use the shared reportability rules, not UI display values.

## Failure handling

- A required Charge failure follows the existing integration error path.
- A missing optional reference is not an error; its value stays unavailable.
- A referenced object that cannot be read or validated records a safe
  enrichment failure tied to the Charge and may be retried.
- Rate limits and transient Stripe failures must not turn known values into
  `NULL` or mark an incomplete enrichment pass as fully successful.
- Provider error messages are sanitized and capped; credentials and raw
  response bodies are never stored or displayed.

## Testing

Implementation follows test-driven development and covers:

- the client issues only `GET` requests for every enrichment endpoint;
- Charge, Checkout, Invoice, Payment Method, Customer, and Balance Transaction
  payload validation;
- fixed transaction-contact precedence;
- mutable Payment Method and Customer-profile fallback display without
  reportability or fingerprint changes;
- an existing non-empty value survives a partial webhook or failed lookup;
- conflicting non-empty contacts remain reviewable;
- settlement amounts use decimal strings and preserve their currency;
- fees, net settlement, conversion, and tax evidence do not change gross sales;
- one Charge ID remains one payment across webhook, reconciliation, backfill,
  and CSV evidence;
- optional enrichment failures retain the valid Charge and record a safe error;
- historical enrichment is resumable and idempotent; and
- no sensitive payment-method fields or raw Stripe payloads are persisted or
  exposed to the browser.

Relevant TypeScript, lint, unit/integration, build, and database contract tests
must pass before completion. Any database migration will be supplied as an
explicit file for manual Supabase execution.

## Rollout

1. Rotate the previously displayed Stripe API key and webhook secret and update
   server-only environment values.
2. Apply the enrichment database migration manually in Supabase.
3. Deploy the read-only client, normalizers, persistence, and dashboard support.
4. Run focused tests with Stripe fixtures and a safe read-only live comparison.
5. Restart or run the historical Stripe backfill to enrich existing Charge IDs.
6. Compare a controlled sample of API-enriched records with the Stripe CSV by
   exact Charge ID before relying on the added contact or settlement context.

## Success criteria

- Stripe is never modified.
- An API-enriched record exposes the same relevant information as the Stripe
  export whenever Stripe exposes that information through readable objects.
- Existing Stripe payments are enriched without duplicates.
- Missing information stays missing when no Stripe object supplies it.
- Mutable Payment Method and Customer-profile context is visibly and
  technically separated from transaction evidence.
- Financial totals remain unchanged by fallback contacts, fee, net,
  conversion, or tax enrichment.
