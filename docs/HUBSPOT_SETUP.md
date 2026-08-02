# HubSpot B2B Integration Setup

## Scope and financial boundary

HubSpot is the primary source for B2B companies, deals, pipeline stages, bookings, and renewals. The integration never creates `b2b_recognised_sales`: recognised sales remain a separate, manual Admin/Finance entry.

The application rejects an unapproved HubSpot stage, a missing amount/currency, a non-USD amount without an explicit FX-rate property, or a closed-won deal without a close date. A rejected item is recorded as a safe integration error and is not counted.

## 1. Apply the database migration

Apply `20260802101100_hubspot_sync_identity_constraints.sql` in Supabase SQL Editor after the existing migrations. It makes the HubSpot company and deal identity columns usable for idempotent provider upserts. Do not create or alter tables manually outside the committed migrations.

## 2. Create a HubSpot private app

Create a private app with read access for deals, companies, and owners. Store its access token only as `HUBSPOT_PRIVATE_APP_TOKEN` in local/server environment settings. It must never use a `NEXT_PUBLIC_` variable.

## 3. Verify real HubSpot properties and stages

Do not assume old-project property names are current. In HubSpot, inspect a representative corporate deal and write down the internal property names and the exact pipeline stage IDs. Configure them in `.env.local` using the names in `.env.example`.

`HUBSPOT_STAGE_MAP_JSON` is mandatory. Its values must be existing PLAYBOOK codes: `discovery`, `qualified`, `proposal`, `negotiation`, `closed_won`, or `closed_lost`.

Example only — verify every source key against the live portal before using it:

```env
HUBSPOT_STAGE_MAP_JSON={"prospecting":"discovery","qualification":"qualified","proposal":"proposal","negotiation":"negotiation","closedwon":"closed_won","closedlost":"closed_lost"}
```

For a non-USD HubSpot pipeline, configure an approved source property containing its USD exchange rate in `HUBSPOT_EXCHANGE_RATE_TO_USD_PROPERTY`. The integration retains the source currency, source amount, rate, and USD amount; it never guesses the rate.

## 4. Configure the webhook

Create a HubSpot app/webhook subscription for deal changes and set its target URL to:

```text
https://your-dashboard-domain/api/webhooks/hubspot
```

Set that identical URL as `HUBSPOT_WEBHOOK_CALLBACK_URL` and add the app client secret as `HUBSPOT_WEBHOOK_CLIENT_SECRET`. The endpoint verifies HubSpot v3 signatures over the raw body and rejects requests outside the five-minute replay window. Localhost cannot receive HubSpot webhooks directly; use a controlled public tunnel only for local webhook testing.

## 5. Reconciliation and operator retry

`GET /api/internal/reconcile/hubspot` executes the required 48-hour pull. It requires `Authorization: Bearer <INTEGRATION_CRON_SECRET>`, so configure the production scheduler with that secret. `POST /api/integrations/hubspot/sync` is the equivalent Admin-only manual retry and records the individual Admin in the audit log.

Before enabling a scheduler, run the Admin retry against a small known dataset and verify that the B2B records, booking date, amount, source IDs, and stage history match HubSpot. Repeating the same webhook or reconciliation window must not create additional deals or bookings.

## 6. Required verification

1. An open HubSpot deal appears as B2B pipeline only.
2. A closed-won deal creates one B2B booking dated by HubSpot close date.
3. No recognised-sale row is created by either case.
4. A repeated webhook event and a repeated 48-hour sync do not duplicate B2B data.
5. An unknown stage or invalid FX rate becomes an integration error, not a financial value.
