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

Purpose: B2C payments, renewals and refunds.

Requirements:

- verify webhook signatures
- record provider event IDs
- classify Stripe financial sales as B2C at ingestion
- prevent duplicates
- support refunds without deleting original payments
- support reconciliation

## Tap

Purpose: regional B2C payments.

Apply the same reliability principles as Stripe.

## HubSpot

Purpose: B2B deals, stages, bookings and renewals.

Requirements:

- preserve HubSpot IDs
- validate/mapping fields explicitly
- keep bookings separate from recognised sales/revenue
- store useful sync state/errors
- support reconciliation/daily sync as required

### Current clean-rebuild boundary

The HubSpot boundary lives in `src/lib/integrations/hubspot/`; the trusted persistence and orchestration layers live in `src/server/`. It accepts only verified v3 webhook requests, stores provider event IDs, and performs a 48-hour reconciliation pull. A required B2B pipeline ID prevents HubSpot B2C and archive pipelines from being imported as B2B. Actual property names and stage IDs are mandatory environment configuration, not assumptions copied from the old project. Read [HUBSPOT_SETUP.md](HUBSPOT_SETUP.md) before enabling it.

A `closed_won` mapped deal creates one separate `b2b_bookings` row using its HubSpot close date. No HubSpot action can create a recognised-sales row.

A HubSpot deal with no amount or currency is retained as an incomplete source record plus an open `needs_follow_up` review flag. Its monetary values remain `NULL`, it is excluded from totals, and it cannot create a booking until an Admin records a correction.

## Reconciliation

Webhooks are not assumed to be perfect.

Reconciliation must safely re-check recent provider records without double counting them.

The approved requirement is a 48-hour lookback with duplicate protection.
