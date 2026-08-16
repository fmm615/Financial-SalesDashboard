# Persistent integration run summary

## Purpose

Let an administrator see the most recent saved integration outcome after closing
or refreshing the Administration page. This removes any need to re-run an
integration merely to recover its totals.

## Scope

The Integration Status section will show one summary for each provider:

- Stripe
- Tap
- HubSpot

Each provider summary will contain the latest historical-backfill state:

- status
- total records processed
- total records flagged or failed
- completion time, when available
- a safe error message, when the run failed

It will also state clearly when no historical backfill has been run for that
provider.

## Data flow and access

The server will read the latest `historical_backfill` row per provider from the
existing `integration_sync_runs` audit table. The existing authenticated Admin
page will receive this data on load, and the client controls will refresh the
display after they finish a backfill.

This is a read-only local dashboard query. It must not call Stripe, Tap, or
HubSpot; restart a backfill; change provider records; or expose credentials,
raw provider payloads, or unsafe error data.

## UX

The summary is shown above the existing action controls so an administrator can
first see what happened, then decide whether a restart is required. A completed
run is distinct from a run with source failures. An in-progress run is shown as
processing, rather than as complete or zero.

## Error handling

If the summary query fails, the Integration Status section remains usable and
shows a safe message that saved run history could not be loaded. It does not
infer totals from B2C or B2B dashboard counts.

## Tests

Tests will cover mapping the latest persisted state, no-run state, safe error
display, and refresh after a completed backfill response. Existing integration
tests must remain green.
