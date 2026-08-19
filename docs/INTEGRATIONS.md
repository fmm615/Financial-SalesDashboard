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
- A Stripe charge with no valid transaction email is retained with a `Missing customer email` flag. PLAYBOOK reads transaction contacts in fixed order from the Charge, completed Checkout Session, and finalized Invoice snapshots. Current Payment Method and Customer-profile contacts may appear as explicitly labelled fallback context, but they do not replace transaction fields, satisfy reportability, change duplicate fingerprints, or resolve review items. Without an approved `product_mappings` record, a charge is likewise retained with an `unmapped_product` flag. Both are excluded by default; possible content duplicates are retained, flagged, and excluded pending Admin review.
- Stripe enrichment follows exact references using GET-only requests for the Charge, PaymentIntent-related Checkout Session and line items, Invoice, Payment Method, Customer, and Balance Transaction. The same Charge ID always updates the same local payment. Optional lookup or validation failures retain the valid Charge, record a safe reviewable integration error, and leave known enrichment values intact for retry.
- Balance Transaction gross, fee, fee-tax, net, settlement currency, and Stripe exchange-rate values are retained as separate reconciliation evidence. The source charge amount remains gross (including customer VAT when Stripe's charge includes it); net payout is the settlement after Stripe fees, not sales or recognised revenue. Direct Invoice tax may also be retained. These fields never replace Charge gross sales, establish a Finance-approved conversion, subtract VAT, or alter B2C totals.
- Approved users can inspect a narrow, read-only **View Stripe details** panel in B2C Operations. It shows only selected charge description, seller message, cardholder name, original currency/amount, Stripe's charge-level refunded amount, settlement amounts/currency/rate, fee, fee tax, net payout, and linked refund settlement evidence. It exposes neither raw provider payloads nor card/payment-method details, and it has no Stripe mutation path.
- For Checkout payments with exactly one priced line item, PLAYBOOK follows the Charge's PaymentIntent to the related Checkout Session line item using read-only Stripe requests. It stores the direct Stripe Price ID as the fallback product reference and displays the Price/Product plan name (for example, `Founding Membership`) as the source tier. A configured Charge metadata product reference remains preferred. Charges not created through Checkout—or Checkout carts with more than one priced product—remain reviewable rather than guessed; multiple items require a Finance-approved allocation rule.
- An Admin can open a flagged Stripe payment in **B2C Operations**, create or update a local mapping for the exact Stripe product reference, and supply an audit reason. The local mapping updates the matching PLAYBOOK payment classifications and resolves their `unmapped_product` review flags; it never sends a request to Stripe. When Stripe does not provide either configured metadata or a Checkout Price reference, no reusable mapping is possible. An Admin may close the review item with a note, but the payment remains excluded until the required source data is genuinely available.
- An Admin can open **Edit locally** for any B2C payment and record a verified local correction for that one PLAYBOOK record's name, email, phone, category, tier, USD amount, or business date. The correction is stored separately from the Stripe source with the Admin actor, reason, before/after values, and audit event; it never changes Stripe. Local amount and business-date corrections drive PLAYBOOK period reporting while the original Stripe amount and timestamp stay available for traceability. A verified local email or category clears only its matching missing-data flag, then the corrected payment must still pass the same 48-hour duplicate check. An Admin may also resolve or dismiss any B2C review item with a required note. Closing a task without a verified correction does not manufacture reportability.
- When source information is genuinely unavailable, an Admin may use the explicit **Finance inclusion exception** for one succeeded USD B2C payment. It requires the exact unique provider transaction ID, a verified local PLAYBOOK category, a reason/evidence note, an explicit confirmation of the provider ID, and a confirmation that available evidence shows no known duplicate. It is a separate append-only local decision, visibly labelled in the ledger and Audit Log. It may bypass only missing-source email or product-mapping gates; it never bypasses a failed/pending payment, a possible duplicate, another unresolved source issue, or a missing Finance-approved FX conversion. It never writes to Stripe.
- The **Audit Log** now reads the append-only `audit_events` and `financial_corrections` records through Admin-only RLS. It displays each local B2C correction's saved reason, before/after snapshot, actor, and timestamp alongside other database audit activity.
- `category` is a PLAYBOOK reporting classification, not a Stripe field. Stripe Price/Product IDs and any Price recurring interval are retained as direct source metadata. An Admin maps a stable Stripe product reference to a PLAYBOOK category and membership tier; without that approved local mapping, the payment remains unmapped and excluded from financial totals.
- When a charge has exactly one Stripe Checkout Price, PLAYBOOK reads and displays that Price's direct billing interval (for example, Monthly or Annual) beside the source plan/tier. This is non-financial context only; it does not create a renewal, change a payment, or write anything to Stripe.
- B2C Operations separates **completed USD source-payment volume** from **reportable B2C payments**. The former is a traceability/operational figure only. Foreign source amounts remain visible in their original currency through the `Needs FX review` filter but never enter this USD figure. Reportable totals include only succeeded USD payments that pass the verified-email, approved PLAYBOOK-category, duplicate, and review gates; eligible USD refunds reduce only those reportable totals. The calculation breakdown displays source volume, exclusions, and all relevant counts so a `$0.00` reportable total is never mistaken for missing source data.
- B2C Operations also reads the persisted Stripe historical-backfill state before publishing a financial total. If no complete history exists, or a completed backfill still has source-record failures, retrieved records remain visible but reportable-payment, refund, and net-cash cards show **Not fully loaded**. A clean completed backfill makes those figures available and the dashboard states the latest known source-data "as of" time. This prevents an incomplete history from being presented as a confirmed zero or a complete financial total.

Read [STRIPE_SETUP.md](STRIPE_SETUP.md) before adding live credentials or an endpoint.

## Tap

Purpose: regional B2C payments.

The Tap boundary lives in `src/lib/integrations/tap/`; the sync service writes only to local PLAYBOOK tables. It is read-only against Tap: the client has only Tap's charge/refund list queries and single-charge retrieval. The list API uses `POST` to submit a search query, but the client contains no Tap create, update, refund, or delete method.

- An Admin can run the 48-hour reconciliation and the resumable historical import from **Admin → Integration status**. Each historical page has at most 50 provider records. Provider IDs make retries idempotent locally.
- Tap's signed webhook endpoint is `/api/webhooks/tap`. It validates Tap's `hashstring` before local processing. The webhook records the posted charge locally; it does not call Tap back.
- A Tap payment keeps its original provider transaction ID, direct customer name/email/mobile when supplied, source product reference, provider status, and source references. Missing values remain `—` and are flagged; no Slack or profile fallback is used.
- B2C Operations shows the retained provider description and original source currency for each ledger record. For Tap, the description comes from the saved Tap charge metadata; it remains `—` only when Tap did not supply one. These source fields are distinct from Tap's BHD settlement-statement evidence and do not require a re-import after a display-only change.
- Every approved user can use the B2C ledger's read-only **Tap statement unmatched** filter. It shows a completed Tap-statement `sale` evidence row only when its provider payment ID has no locally imported Tap API payment. Those rows are statement evidence, not B2C payments: they have no USD reporting amount, cannot be corrected or included from the ledger, and never affect B2C or Finance totals. The safe projection exposes no raw provider payload; only Admins retain write actions elsewhere in PLAYBOOK.
- If the completed Tap statement contains an unmatched sale without a usable business date, PLAYBOOK retains it as **Date unavailable** in the All time unmatched review. It is not assigned to any reporting month and never enters B2C or Finance totals.
- Non-USD Tap charges/refunds retain their original amount and currency. They are excluded from USD financial totals until an Admin records a separate, Finance-approved local FX conversion with its rate, source, date, and reason. PLAYBOOK never silently converts Tap data.
- Tap product mappings and one-payment local corrections use the same B2C controls as Stripe. They are source-system scoped, append-only/audited locally, and never change Tap. Finance exceptions never bypass failed/pending, duplicate, or unresolved blocking issues.
- Combined B2C Finance totals are shown only after every active provider's historical import completes cleanly. This prevents a complete Stripe history plus a partial Tap history from being presented as a complete B2C total.

Read [TAP_SETUP.md](TAP_SETUP.md) before adding a Tap key or webhook endpoint.

## B2C Finance workbook reconciliation

The Finance Payment Tracker is not a provider integration and is not imported
into `b2c_payments`. Its first supported workbook scope is exactly the `B2C`
and `B2C Cons` tabs. These are USD Finance revenue candidates excluding customer
VAT. They overlap, so they must never be added together as independent sources.

- `20260812090000_b2c_finance_reconciliation_staging.sql` retains immutable
  source-file provenance, Finance staging rows, provider evidence, typed
  reconciliation groups, and append-only Finance decisions. Admin-only RLS
  protects every raw table and no delete policy exists.
- `20260812091000_finalize_b2c_finance_import.sql` stores one already-parsed
  Payment Tracker import atomically. The current API never parses raw `.xlsx`
  bytes or marks an upload successful without a dedicated, validated parser.
- A file SHA-256 is unique. Finance rows are unique by import, tab, and
  one-based row number. Bad, missing, and zero values are retained as source
  history, never converted into `$0` revenue.
- Duplicate matching proposes a decision only. E-mail is preferred; without it,
  name, payment method, amount, and date evidence are required. A later recurring
  payment is not treated as a duplicate merely because the name and amount match.
- Date parsing never guesses a day/month order or repairs a contradictory month
  label. Tap statement `Sale -`, processing-fee, fee-VAT, transfer, opening-balance,
  refund, and unrecognised rows stay as original-currency evidence. Tap BHD is
  never converted to USD without Finance-approved FX.
- The `B2C reconciliation` Operations screen shows only safe source status and
  counts. Its `Not fully loaded` gate remains until the Payment Tracker, Tap
  statement, full Stripe Charges export, reconciliation, and Finance approval
  are complete. It never publishes B2C Finance revenue or exposes raw evidence
  to a Viewer.

The full Stripe Charges export is still required before any B2C Finance period
can be verified. An Admin may securely stage an approved Payment Tracker
`.xlsx`: the server accepts only `B2C` and `B2C Cons`, previews safe quality
counts, requires explicit confirmation of the same SHA-256 file, and retains
the original in the private Admin-only `b2c-finance-imports` bucket before its
rows are atomically staged. This creates neither a provider payment nor a
reportable total. Stripe export parsing/upload, automated group construction,
and Finance period approval remain later work.

An Admin may also stage one complete Tap statement CSV as original-currency
evidence. The server retains sales, fees, fee VAT, refunds, transfers, opening
balances, and unknown lines through a separate atomic function. Tap evidence
does not create B2C Finance revenue or a USD conversion.

Stripe Charges CSV evidence uses an analogous private, Admin-only source
boundary. Each source row has a primary evidence entry, and a directly stated
refund receives a separately linked refund entry. The source retains original
currency only; Stripe export conversion columns are never treated as a USD
rate. Typed name, email, and phone support Admin review, while card, address,
fingerprint, IP, payment-method, and metadata values stay only in the private
original CSV. No Stripe CSV upload creates B2C Finance revenue or a payment.

Exact Payment Tracker duplicate grouping is internal Finance reconciliation,
not a Stripe or Tap integration. It compares the fields shared consistently by
the two Finance tabs: normalized customer name, business date, USD amount, and
payment method. `B2C` type and `B2C Cons` category/membership fields are not
treated as equivalent, and historical cross-tab e-mail coverage is absent.
Provider evidence may support an Admin review but cannot automatically link or
create Finance revenue.

Every staged Finance row resolves to a stable, content-derived lineage
identity from the same four fields used for exact duplicate grouping. The same
real-world payment keeps the same lineage across every re-upload, so a
replacement workbook can never repost a payment a prior import already staged.
Once any Payment Tracker import has completed, a new import must declare which
completed import it supersedes; the server rejects an import that omits this
without ever touching Storage or the database. Rows unchanged from the
declared prior import link straight to their existing lineage automatically.
A genuinely new identity, a repeated identity shared by more than one row, or
an identity that already matches an existing payment stays a non-postable
candidate until an Admin records `confirm_new`, `link_revision`, or
`link_existing_manual`; leaving a candidate undecided performs no write and it
can never post.

A manual bank transfer reserves its payment identity the moment it is
recorded, independent of any workbook. If a later Payment Tracker upload
contains that same transfer, preview and finalization surface it as an
existing-payment candidate rather than a new lineage. An Admin's
`link_existing_manual` decision attaches the workbook row to the reserved
lineage as evidence only; it never creates a second payment and never changes
the manual payment's amount, date, or source system.

Approved Finance posting also resolves every confirmed lineage to its current
linked row before checking eligibility, so a replacement workbook's unchanged
row is recognized as already posted rather than creating a duplicate
`finance_tracker` payment. A lineage represented by a manual bank transfer is
excluded from posting entirely, for the same reason it is excluded from the
version-diff candidates above.

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
