# Integration Rules

## General pattern

Keep each external provider isolated behind its own integration module.

Suggested structure:

```text
src/lib/integrations/
├── stripe/
├── tap/
└── hubspot/
```

Each integration should separate concerns such as:

- client/API access
- authentication/signature verification
- payload validation
- mapping/normalization
- webhook processing
- reconciliation/synchronization

## Normalize provider data

Do not allow provider-specific payloads to flow directly through the application.

Convert them into internal domain structures first.

## Stripe

- Admins can run a historical B2C backfill from **Admin → Integration status**. It reads all charges and refunds through the Stripe API in resumable pages of up to 100 records. The progress is retained in `integration_sync_runs`; restarting or retrying does not duplicate records because the Stripe provider IDs are unique locally.
- **Admin → Integration status** retains the latest saved historical-backfill summary for Stripe, Tap, and HubSpot after a page refresh. It shows the local run state, processed and flagged counts, completion time, and any already-sanitised failure summary. These are operational audit totals, not financial or revenue totals; an Admin should not restart a provider merely to view a prior count.
- The existing 48-hour reconciliation remains the routine operational sync after the historical import.

Purpose: B2C payments, renewals and refunds.

Requirements:

- verify webhook signatures
- record provider event IDs
- classify Stripe financial sales as B2C at ingestion
- prevent duplicates
- support refunds without deleting original payments
- support reconciliation

### Foreign-currency B2C handling

PLAYBOOK imports the source currency and source amount exactly as Stripe or Tap
returns them. A foreign-currency source payment or refund is visible in B2C
Operations with a **Finance FX review** status, but contributes nothing to
USD-only reporting. An Admin can record a local Finance-approved USD
conversion by entering the USD-per-unit rate, rate source, effective date, and
reason. The server calculates the USD amount from the preserved source amount,
appends a conversion and audit record, and can then include the converted
source record under the normal B2C reportability rules. No flow issues a
create, update, refund, or delete request to Stripe or Tap.

### Current clean-rebuild boundary

The Stripe boundary lives in `src/lib/integrations/stripe/`; trusted persistence and orchestration live in `src/server/`. It is read-only against Stripe: PLAYBOOK only makes `GET` requests and never creates, edits, or deletes anything in Stripe.

- The webhook endpoint is `/api/webhooks/stripe`. It verifies Stripe's signature against the untouched raw request body before parsing it.
- It accepts `charge.succeeded`, `charge.failed`, `refund.created`, and `refund.updated`. Webhook event IDs and provider transaction IDs make delivery idempotent.
- The Admin Integration Status screen can run the required 48-hour read-only reconciliation. The authenticated Admin is recorded in the audit log. Scheduled reconciliation uses `/api/internal/reconcile/stripe` and `INTEGRATION_CRON_SECRET`.
- A refund is always a separate `b2c_refunds` row linked to the original `b2c_payments` row. It never deletes or overwrites the payment.
- USD Stripe charges and refunds retain their USD reporting values. A valid non-USD Stripe charge or refund is also retained in the source ledger with its exact original amount and currency and a `Needs FX review` flag. PLAYBOOK never turns Stripe settlement conversion evidence into a reporting rate. Foreign-currency source records are excluded from USD totals and cannot use a Finance inclusion exception until Finance approves a conversion source and accounting rule.
- A Stripe charge with no valid transaction email is retained with a `Missing customer email` flag. PLAYBOOK reads transaction contacts in fixed order from the Charge, completed Checkout Session, and finalized Invoice snapshots. Current Payment Method and Customer-profile contacts may appear as explicitly labelled fallback context, but they do not replace transaction fields, satisfy reportability, change duplicate fingerprints, or resolve review items. A missing product mapping does not create a live flag or exclude an otherwise-valid payment; historical `unmapped_product` flags remain read-only audit evidence. Possible content duplicates are retained, flagged, and excluded pending Admin review.
- Stripe enrichment follows exact references using GET-only requests for the Charge, PaymentIntent-related Checkout Session and line items, Invoice, Payment Method, Customer, and Balance Transaction. The same Charge ID always updates the same local payment. Optional lookup or validation failures retain the valid Charge, record a safe reviewable integration error, and leave known enrichment values intact for retry.
- Balance Transaction gross, fee, fee-tax, net, settlement currency, and Stripe exchange-rate values are retained as separate reconciliation evidence. The source charge amount remains gross (including customer VAT when Stripe's charge includes it); net payout is the settlement after Stripe fees, not sales or recognised revenue. Direct Invoice tax may also be retained. These fields never replace Charge gross sales, establish a Finance-approved conversion, subtract VAT, or alter B2C totals.
- Approved users can inspect a narrow, read-only **View Stripe details** panel in B2C Operations. It shows only selected charge description, seller message, cardholder name, original currency/amount, Stripe's charge-level refunded amount, settlement amounts/currency/rate, fee, fee tax, net payout, and linked refund settlement evidence. It exposes neither raw provider payloads nor card/payment-method details, and it has no Stripe mutation path.
- For Checkout payments with exactly one priced line item, PLAYBOOK follows the Charge's PaymentIntent to the related Checkout Session line item using read-only Stripe requests. It stores the direct Stripe Price ID as the fallback product reference and displays the Price/Product plan name (for example, `Founding Membership`) as the source tier. A configured Charge metadata product reference remains preferred. Charges not created through Checkout—or Checkout carts with more than one priced product—remain reviewable rather than guessed; multiple items require a Finance-approved allocation rule.
- Provider descriptions and plan names are retained as source evidence and shown as the visible product label. A Stripe category/tier is optional local metadata; PLAYBOOK neither derives it from free text nor offers a live reusable mapping workflow. Historical mapping records, functions, classifications, and flags are retained read-only for audit, with their write permissions revoked by `20270101000200_b2c_foundation.sql`.
- An Admin can open **Edit locally** for any B2C payment and record a verified local correction for that one PLAYBOOK record's name, email, phone, category, tier, USD amount, or business date. The correction is stored separately from the Stripe source with the Admin actor, reason, before/after values, and audit event; it never changes Stripe. Local amount and business-date corrections drive PLAYBOOK period reporting while the original Stripe amount and timestamp stay available for traceability. A verified local email correction closes its matching missing-email flag, and the corrected payment must still pass the same 48-hour duplicate check. Category remains optional per-record metadata, not a reportability gate; retired historical `unmapped_product` flags have no live mapping workflow. An Admin may also resolve or dismiss any B2C review item with a required note. Closing a task without a verified correction does not manufacture reportability.
- When source information is genuinely unavailable, an Admin may use the explicit **Finance inclusion exception** for one succeeded USD B2C payment. It requires the exact unique provider transaction ID, a reason/evidence note, an explicit confirmation of the provider ID, and a confirmation that available evidence shows no known duplicate. Category is not required. It is a separate append-only local decision, visibly labelled in the ledger and Audit Log. It may bypass only the approved missing-source email rule; it never bypasses a failed/pending payment, a possible duplicate, another unresolved source issue, or a missing Finance-approved FX conversion. It never writes to Stripe.
- The **Audit Log** now reads the append-only `audit_events` and `financial_corrections` records through Admin-only RLS. It displays each local B2C correction's saved reason, before/after snapshot, actor, and timestamp alongside other database audit activity.
- `category` is optional PLAYBOOK local metadata, not a Stripe field or a provider-payment reporting prerequisite. Stripe Price/Product IDs and any Price recurring interval are retained as direct source metadata. The validated provider description is the visible product label. `unmapped` remains only the stable internal duplicate-fingerprint category; free-text descriptions never become a fingerprint identity or inferred normalized category.
- When a charge has exactly one Stripe Checkout Price, PLAYBOOK reads and displays that Price's direct billing interval (for example, Monthly or Annual) beside the source plan/tier. This is non-financial context only; it does not create a renewal, change a payment, or write anything to Stripe.
- B2C Operations separates **completed USD source-payment volume** from **reportable B2C payments**. The former is a traceability/operational figure only. Foreign source amounts remain visible in their original currency through the `Needs FX review` filter but never enter this USD figure. Reportable totals include only succeeded USD payments that pass the verified-email, duplicate, and remaining review gates; category/mapping is not a gate. Eligible USD refunds reduce only those reportable totals. The calculation breakdown displays source volume, exclusions, and all relevant counts so a `$0.00` reportable total is never mistaken for missing source data.
- B2C Operations also reads the persisted Stripe historical-backfill state before publishing a financial total. If no complete history exists, or a completed backfill still has source-record failures, retrieved records remain visible but reportable-payment, refund, and net-cash cards show **Not fully loaded**. A clean completed backfill makes those figures available and the dashboard states the latest known source-data "as of" time. This prevents an incomplete history from being presented as a confirmed zero or a complete financial total.

Read [STRIPE_SETUP.md](STRIPE_SETUP.md) before adding live credentials or an endpoint.

## Tap

Purpose: regional B2C payments.

The Tap boundary lives in `src/lib/integrations/tap/`; the sync service writes only to local PLAYBOOK tables. It is read-only against Tap: the client has only Tap's charge/refund list queries and single-charge retrieval. The list API uses `POST` to submit a search query, but the client contains no Tap create, update, refund, or delete method.

- An Admin can run the 48-hour reconciliation and the resumable historical import from **Admin → Integration status**. Each historical page has at most 50 provider records. Provider IDs make retries idempotent locally.
- Tap's signed webhook endpoint is `/api/webhooks/tap`. It validates Tap's `hashstring` before local processing. The webhook records the posted charge locally; it does not call Tap back.
- A Tap payment keeps its original provider transaction ID, direct customer name/email/mobile when supplied, source product reference, provider status, and source references. Missing values remain `—` and are flagged; no Slack or profile fallback is used.
- B2C Operations shows the retained provider description and original source currency for each ledger record. For Tap, the description comes from the saved Tap charge metadata; it remains `—` only when Tap did not supply one. These source fields are distinct from Tap's BHD settlement-statement evidence and do not require a re-import after a display-only change.
- Non-USD Tap charges/refunds retain their original amount and currency. They are excluded from USD financial totals until an Admin records a separate, Finance-approved local FX conversion with its rate, source, date, and reason. PLAYBOOK never silently converts Tap data.
- Tap provider descriptions are source evidence and the visible product label; category/tier are optional local metadata. There is no live Tap mapping workflow. Retained mapping history is read-only, and `unmapped` remains only the internal duplicate-fingerprint value. One-payment local corrections remain append-only/audited and never change Tap. Finance exceptions never bypass failed/pending, duplicate, USD/FX, or unresolved blocking issues.
- Combined B2C Finance totals are shown only after every active provider's historical import completes cleanly. This prevents a complete Stripe history plus a partial Tap history from being presented as a complete B2C total.

Read [TAP_SETUP.md](TAP_SETUP.md) before adding a Tap key or webhook endpoint.

## B2C Finance workbook reconciliation (removed)

The Finance Payment Tracker Excel-workbook system -- staging, provider-evidence
matching against Stripe/Tap, exact `B2C`/`B2C Cons` cross-tab duplicate
grouping, lineage/canonicalization, Finance staging-row corrections, and
posting approved iOS/bank-transfer rows into real B2C payments -- is not part
of the schema (`20270101000200_b2c_foundation.sql`, the B2C domain migration,
deliberately excludes it entirely).
Stripe and Tap's own APIs are now the sole source of truth for those two
providers; the sheet is no longer cross-referenced against either.

Historical `b2c_payments` rows with `source_system = 'finance_tracker'` remain
untouched, immutable reportable ledger history (labelled Finance -- iOS /
Finance -- Bank transfer); no new ones can be created. `record_b2c_manual_bank_transfer`
(`src/server/services/record-manual-bank-transfer.ts`) continues to work for
genuinely new bank transfers: it still rejects an exact bank-reference match
outright and retains-with-a-flag a possible 48-hour content-duplicate match
(now handled entirely by the general `b2c_payment_duplicate_groups` system);
only its former check against Payment Tracker lineage was removed, since that
lineage system no longer exists.

A new iOS/bank-transfer ingestion system is pending a separate design; there
is an intentional functionality gap for that ingestion until it is built.

## HubSpot

Purpose: B2B deals, stages, and bookings.

Requirements:

- preserve HubSpot IDs
- validate/mapping fields explicitly
- keep bookings separate from recognised sales/revenue
- store useful sync state/errors
- support reconciliation/daily sync as required

### Current clean-rebuild boundary

The HubSpot boundary lives in `src/lib/integrations/hubspot/`; the trusted persistence and orchestration layers live in `src/server/`. It accepts only verified v3 webhook requests, stores provider event IDs, and performs a 48-hour reconciliation pull. A required B2B pipeline ID prevents HubSpot B2C and archive pipelines from being imported as B2B. Actual property names and stage IDs are mandatory environment configuration, not assumptions copied from the old project. Read [HUBSPOT_SETUP.md](HUBSPOT_SETUP.md) before enabling it. The client enforces a read-only allowlist: `GET` requests plus HubSpot's read-only CRM deal-search `POST` endpoint only; update, create, and delete provider calls are rejected.

A `closed_won` mapped deal creates one separate `b2b_bookings` row using its HubSpot close date. No HubSpot action can create a recognised-sales row.

Renewal tracking is currently disabled. HubSpot has no verified renewal-date property, so PLAYBOOK does not infer a renewal from a close date or booking. The retained `b2b_deals.renewal_date` database field is dormant for historical compatibility and a future Finance-approved source mapping; it is not collected or shown in B2B Operations.

A HubSpot deal with no amount or currency is retained as an incomplete source record plus an open `needs_follow_up` review flag. Its monetary values remain `NULL`, it is excluded from totals, and it cannot create a booking until an Admin records a correction. A closed-won deal with valid financial values but no close date is also retained; it receives a separate Admin local close-date correction workflow and cannot create a booking until that date is recorded locally with an audit reason.

The Admin Integration Status screen is for reconciliation/backfill controls and possible duplicate decisions. Day-to-day deal corrections happen in **B2B Operations**: every active imported HubSpot deal is visible there, with an issue flag where it needs review. An Admin can save a complete, local audited override or exclude the source record locally with a reason. Exclusion removes it from PLAYBOOK views and totals but keeps the HubSpot source row and audit trail. A later read-only HubSpot sync cannot silently undo a documented local override. These actions never issue a HubSpot write request. A local override clears matching per-deal HubSpot error tickets only after the local change has been stored and audited.

B2B Operations may show all active source deals so an Admin can correct them in context, but every dashboard KPI and report total must use `public.reportable_b2b_deals`. That view exposes only complete, active deals that have cleared duplicate review (or were explicitly included) and, for closed-won deals, a known close date. Records awaiting a financial, duplicate, or close-date correction remain traceable but are excluded from every financial total.

The B2B Operations month control changes the reporting period for recognised sales and the containing quarter for bookings. Open pipeline is intentionally a live current-state figure: a deal's current stage cannot be used to reconstruct a historical pipeline snapshot. Metric labels must always name the actual selected month or quarter rather than saying “this month” or “this quarter”.

When HubSpot is unavailable, an Admin may create a **manual Finance B2B deal** directly in B2B Operations. The server validates the original amount, ISO currency, FX rate, stage, and required reason; it records the authenticated Admin through existing source and audit triggers. A closed-won entry with a close date creates a separate manual booking. Manual entry never creates a receipt or recognised-sales record, and exact duplicate candidates are paused for an audited Admin decision. This local workflow never sends a request to HubSpot.

An Admin records a **B2B recognised-sale** entry separately from the eligible deal’s B2B Operations row. The entry is linked to that deal and, where present, its booking; it requires original amount/currency, FX rate, recognition date, monthly reporting period, and Finance reason or reference. The USD amount is calculated as original recognised amount × FX rate, shown read-only to the Admin, and stored to six decimal places. It uses the authenticated request client and database audit trigger, never writes to HubSpot, and does not alter the booking, invoice, or receipt. The database rejects an entry that would make the cumulative recognised USD total exceed the linked deal’s USD amount; an Admin must first save an audited local deal correction if that approved value genuinely changed. If the selected reporting month contains no recognised-sale row, the dashboard shows **Not yet recorded**, rather than treating the absence as `$0`.

Historical backfill reads the entire configured B2B pipeline in durable, paginated batches. It is separate from the mandatory 48-hour reconciliation: the former loads history once, while the latter keeps recent changes current.

## Reconciliation

Webhooks are not assumed to be perfect.

Reconciliation must safely re-check recent provider records without double counting them.

The approved requirement is a 48-hour lookback with duplicate protection.
