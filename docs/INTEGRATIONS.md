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
- A Stripe charge with no valid direct customer email is still retained in the B2C source ledger with `—` in the email field and a `Missing customer email` flag. It is excluded from all financial totals because it cannot complete the approved email-based content duplicate check. PLAYBOOK never substitutes a Stripe Customer-profile email or another source. Without an approved `product_mappings` record, a charge is likewise retained with an `unmapped_product` flag and excluded. Possible content duplicates are retained, flagged, and excluded pending Admin review.
- When Stripe provides a phone directly on a charge's billing or shipping details, PLAYBOOK stores and displays it for traceability. A missing or invalid source phone is displayed as `—`; PLAYBOOK never obtains phone details from Slack or another customer profile.

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

The HubSpot boundary lives in `src/lib/integrations/hubspot/`; the trusted persistence and orchestration layers live in `src/server/`. It accepts only verified v3 webhook requests, stores provider event IDs, and performs a 48-hour reconciliation pull. A required B2B pipeline ID prevents HubSpot B2C and archive pipelines from being imported as B2B. Actual property names and stage IDs are mandatory environment configuration, not assumptions copied from the old project. Read [HUBSPOT_SETUP.md](HUBSPOT_SETUP.md) before enabling it.

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
