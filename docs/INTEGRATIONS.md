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
- The existing 48-hour reconciliation remains the routine operational sync after the historical import.

Purpose: B2C payments, renewals and refunds.

Requirements:

- verify webhook signatures
- record provider event IDs
- classify Stripe financial sales as B2C at ingestion
- prevent duplicates
- support refunds without deleting original payments
- support reconciliation

### Current clean-rebuild boundary

The Stripe boundary lives in `src/lib/integrations/stripe/`; trusted persistence and orchestration live in `src/server/`. It is read-only against Stripe: PLAYBOOK only makes `GET` requests and never creates, edits, or deletes anything in Stripe.

- The webhook endpoint is `/api/webhooks/stripe`. It verifies Stripe's signature against the untouched raw request body before parsing it.
- It accepts `charge.succeeded`, `charge.failed`, `refund.created`, and `refund.updated`. Webhook event IDs and provider transaction IDs make delivery idempotent.
- The Admin Integration Status screen can run the required 48-hour read-only reconciliation. The authenticated Admin is recorded in the audit log. Scheduled reconciliation uses `/api/internal/reconcile/stripe` and `INTEGRATION_CRON_SECRET`.
- A refund is always a separate `b2c_refunds` row linked to the original `b2c_payments` row. It never deletes or overwrites the payment.
- PLAYBOOK currently accepts only USD Stripe charges and refunds. A non-USD Stripe record is retained as a safe follow-up error because no Finance-approved FX source exists; it is never silently converted.
- A Stripe charge with no valid direct customer email is retained in the B2C source ledger with `—` in the email field and a `Missing customer email` flag. PLAYBOOK never substitutes a Stripe Customer-profile email or another source. Without an approved `product_mappings` record, a charge is likewise retained with an `unmapped_product` flag. Both are excluded by default; possible content duplicates are always retained, flagged, and excluded pending Admin review.
- When Stripe provides a phone directly on a charge's billing or shipping details, PLAYBOOK stores and displays it for traceability. A missing or invalid source phone is displayed as `—`; PLAYBOOK never obtains phone details from Slack or another customer profile.
- For Checkout payments with exactly one priced line item, PLAYBOOK follows the Charge's PaymentIntent to the related Checkout Session line item using read-only Stripe requests. It stores the direct Stripe Price ID as the fallback product reference and displays the Price/Product plan name (for example, `Founding Membership`) as the source tier. A configured Charge metadata product reference remains preferred. Charges not created through Checkout—or Checkout carts with more than one priced product—remain reviewable rather than guessed; multiple items require a Finance-approved allocation rule.
- An Admin can open a flagged Stripe payment in **B2C Operations**, create or update a local mapping for the exact Stripe product reference, and supply an audit reason. The local mapping updates the matching PLAYBOOK payment classifications and resolves their `unmapped_product` review flags; it never sends a request to Stripe. When Stripe does not provide either configured metadata or a Checkout Price reference, no reusable mapping is possible. An Admin may close the review item with a note, but the payment remains excluded until the required source data is genuinely available.
- An Admin can open **Edit locally** for any B2C payment and record a verified local correction for that one PLAYBOOK record's name, email, phone, category, tier, USD amount, or business date. The correction is stored separately from the Stripe source with the Admin actor, reason, before/after values, and audit event; it never changes Stripe. Local amount and business-date corrections drive PLAYBOOK period reporting while the original Stripe amount and timestamp stay available for traceability. A verified local email or category clears only its matching missing-data flag, then the corrected payment must still pass the same 48-hour duplicate check. An Admin may also resolve or dismiss any B2C review item with a required note. Closing a task without a verified correction does not manufacture reportability.
- When source information is genuinely unavailable, an Admin may use the explicit **Finance inclusion exception** for one succeeded B2C payment. It requires the exact unique provider transaction ID, a verified local PLAYBOOK category, a reason/evidence note, an explicit confirmation of the provider ID, and a confirmation that available evidence shows no known duplicate. It is a separate append-only local decision, visibly labelled in the ledger and Audit Log. It may bypass only missing-source email or product-mapping gates; it never bypasses a failed/pending payment, a possible duplicate, or another unresolved source issue. It never writes to Stripe.
- The **Audit Log** now reads the append-only `audit_events` and `financial_corrections` records through Admin-only RLS. It displays each local B2C correction's saved reason, before/after snapshot, actor, and timestamp alongside other database audit activity.
- `category` is a PLAYBOOK reporting classification, not a Stripe field. Stripe Price/Product IDs and any Price recurring interval are retained as direct source metadata. An Admin maps a stable Stripe product reference to a PLAYBOOK category and membership tier; without that approved local mapping, the payment remains unmapped and excluded from financial totals.
- When a charge has exactly one Stripe Checkout Price, PLAYBOOK reads and displays that Price's direct billing interval (for example, Monthly or Annual) beside the source plan/tier. This is non-financial context only; it does not create a renewal, change a payment, or write anything to Stripe.
- B2C Operations separates **completed source-payment volume** from **reportable B2C payments**. The former is a traceability/operational figure only. Reportable totals include only succeeded payments that pass the verified-email, approved PLAYBOOK-category, duplicate, and review gates; eligible refunds reduce only those reportable totals. The calculation breakdown displays source volume, exclusions, and all relevant counts so a `$0.00` reportable total is never mistaken for missing source data.
- B2C Operations also reads the persisted Stripe historical-backfill state before publishing a financial total. If no complete history exists, or a completed backfill still has source-record failures, retrieved records remain visible but reportable-payment, refund, and net-cash cards show **Not fully loaded**. A clean completed backfill makes those figures available and the dashboard states the latest known source-data "as of" time. This prevents an incomplete history from being presented as a confirmed zero or a complete financial total.

Read [STRIPE_SETUP.md](STRIPE_SETUP.md) before adding live credentials or an endpoint.

## Tap

Purpose: regional B2C payments.

Apply the same reliability principles as Stripe.

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
