# HubSpot B2B Integration Setup

## Scope and financial boundary

HubSpot is the primary source for B2B companies, deals, pipeline stages, bookings, and renewals. The integration never creates `b2b_recognised_sales`: recognised sales remain a separate, manual Admin/Finance entry.

The application rejects an unapproved HubSpot stage, an invalid currency, or a non-USD amount without an explicit FX-rate property. A deal with a missing amount or currency is retained as an incomplete HubSpot source record and flagged for Admin review; it has no financial amount, creates no booking, and is excluded from totals until an audited correction is supplied. A closed-won deal with valid money but no close date is retained only for Admin local correction and is excluded from all B2B dashboards, reports, and bookings until corrected.

The main B2B dashboard displays the HubSpot **deal name**. It intentionally does not display a Company column because a Company association is optional in the source and must not be inferred locally.

## 1. Apply the database migration

Apply `20260802101100_hubspot_sync_identity_constraints.sql` through `20260803140000_manual_b2b_deal_entry.sql` in order, after the existing migrations. These migrations make HubSpot identity upserts safe, retain `PARKED`, protect incomplete data, enable Admin review, create durable resumable historical-backfill state, add audited duplicate decisions, attach exact source references to new HubSpot issues, allow local audited corrections and exclusions from B2B Operations, create the only permitted source for B2B dashboard/report totals, preserve a local date correction during later read-only HubSpot syncs, and add Admin-only local manual-Finance B2B entry. Do not create or alter tables manually outside the committed migrations.

## 2. Create a HubSpot private app

Create a private app with read access for deals, companies, and owners. Store its access token only as `HUBSPOT_PRIVATE_APP_TOKEN` in local/server environment settings. It must never use a `NEXT_PUBLIC_` variable.

## 3. Verify real HubSpot properties and stages

Do not assume old-project property names are current. In HubSpot, inspect a representative corporate deal and write down the internal property names and the exact pipeline stage IDs. Configure them in `.env.local` using the names in `.env.example`.

`HUBSPOT_B2B_PIPELINE_ID` is mandatory. It ensures that the B2C and archive pipelines cannot enter B2B storage. `HUBSPOT_STAGE_MAP_JSON` is mandatory. Its values must be existing PLAYBOOK codes: `discovery`, `qualified`, `proposal`, `negotiation`, `parked`, `closed_won`, or `closed_lost`.

Example only — verify every source key against the live portal before using it:

```env
HUBSPOT_STAGE_MAP_JSON={"prospecting":"discovery","qualification":"qualified","proposal":"proposal","negotiation":"negotiation","closedwon":"closed_won","closedlost":"closed_lost"}
```

The supplied HubSpot account exposes `deal_currency_code` and `hs_exchange_rate`. HubSpot defines that rate as a conversion into the company currency, so set `HUBSPOT_COMPANY_CURRENCY=USD` only after confirming USD in HubSpot Account defaults. The integration then retains the source currency, source amount, rate, and USD amount. If the HubSpot company currency is not USD, stop: Finance must approve a separate source for USD FX rates before importing non-USD deals.

## 4. Configure the webhook

Create a HubSpot app/webhook subscription for deal changes and set its target URL to:

```text
https://your-dashboard-domain/api/webhooks/hubspot
```

Set that identical URL as `HUBSPOT_WEBHOOK_CALLBACK_URL` and add the app client secret as `HUBSPOT_WEBHOOK_CLIENT_SECRET`. The endpoint verifies HubSpot v3 signatures over the raw body and rejects requests outside the five-minute replay window. Localhost cannot receive HubSpot webhooks directly; use a controlled public tunnel only for local webhook testing.

## 5. Reconciliation and operator retry

`GET /api/internal/reconcile/hubspot` executes the required 48-hour pull. It requires `Authorization: Bearer <INTEGRATION_CRON_SECRET>`, so configure the production scheduler with that secret. `POST /api/integrations/hubspot/sync` is the equivalent Admin-only manual retry and records the individual Admin in the audit log.

Before enabling a scheduler, run the Admin retry against a small known dataset and verify that the B2B records, booking date, amount, source IDs, and stage history match HubSpot. Repeating the same webhook or reconciliation window must not create additional deals or bookings.

## 6. Historical B2B backfill

The Admin Integration Status page includes **Historical B2B backfill**. It reads every deal from the configured approved B2B pipeline, regardless of age; it does not use the 48-hour filter. One click continues automatically through persisted batches of up to 50 deals with bounded HubSpot request concurrency. The run stores its pagination cursor and totals in `integration_sync_runs`, so closing the browser does not lose progress and a later click resumes safely. Choosing **Start or restart** after a completed run creates a new audit-preserving run; an active run is always resumed instead. Each record still follows the same pipeline, currency, stage, duplicate, booking, incomplete-data, and recognised-sales safeguards.

Every new per-deal validation error stores a compact reference such as `HubSpot deal 12345 — Acme`. The B2B Operations table shows every active source deal and its review state. An Admin can correct the full local deal record there—including close date—with a required reason, or exclude a source record locally. A supplied local close date can create an audited local booking; an exclusion keeps the source row and audit history but removes it from PLAYBOOK operational views and totals. Neither action updates HubSpot.

When two complete HubSpot deals have the same normalized name, mapped stage, USD amount, and close-date state, they are not counted until an Admin decides to **keep both** or **keep only one**. The screen displays each source deal’s HubSpot ID and relevant values. Decisions require a note, are audited, affect only PLAYBOOK’s local financial view, and never write to HubSpot.

## 7. Required verification

1. An open HubSpot deal appears as B2B pipeline only.
2. A closed-won deal creates one B2B booking dated by HubSpot close date.
3. No recognised-sale row is created by either case.
4. A repeated webhook event and a repeated 48-hour sync do not duplicate B2B data.
5. An unknown stage or invalid FX rate becomes an integration error, not a financial value.
6. A missing HubSpot amount or currency creates an incomplete B2B deal and open review flag, never a zero-value deal or booking.
7. An Admin can correct incomplete B2B deal financial data locally with a required reason. The correction, individual actor, before/after values, and any resulting booking remain in Supabase; HubSpot is never changed.
8. A historical backfill can be paused and resumed without duplicating deals or bookings.
9. Each newly-created per-deal integration issue identifies its HubSpot deal ID/name in B2B Operations.
10. A possible duplicate displays both source deal IDs and requires an audited keep-both or keep-one decision before it is counted.
11. A closed-won deal missing only a close date can receive an Admin local date correction and a separately auditable local booking, without a HubSpot write.
12. B2B dashboards and reports read only `reportable_b2b_deals`; an incomplete, unresolved duplicate, or missing-close-date deal cannot appear in their rows or totals.
13. A later HubSpot sync with a blank close date cannot remove a locally corrected close date or replace its local audited booking.
14. An Admin can edit a source deal locally or exclude it locally from B2B Operations with a reason; both actions are auditable and never change HubSpot.
