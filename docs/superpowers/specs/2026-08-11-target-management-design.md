# Target Management Design

## Purpose

Provide an Admin-controlled place to maintain approved PLAYBOOK targets without
creating a second source of truth for financial actuals. The feature supports
both approved financial targets and flexible, non-financial operational targets.

## Scope

The first release includes target creation, activation, archiving, target
revisions, and manual progress updates for operational targets. It does not
load Excel files, change Stripe, Tap, or HubSpot records, send alerts, or use
targets in financial reports.

## Target categories

### Financial targets

Financial target metric codes are limited to the approved measures:

- B2C cash received
- B2B bookings
- B2B recognised sales
- Total recognised sales

Their target values are entered by an Admin with a Finance reference. Their
actual values are calculated only from verified, reportable source records.
Until the relevant source history is completely loaded and reconciled, the UI
must show `Actuals not fully loaded`; it must not show zero, a manual actual,
or an on-track/at-risk result.

### Custom operational targets

An Admin can create an operational target with a clear display name and either:

- a USD money goal; or
- a non-negative quantity goal with a required unit label, such as `tickets`
  or `deals`.

Operational actuals are intentionally manual in this release. Each update
requires the numeric value, effective date, and a Finance or operational
evidence note. The UI labels these as `Manual operational metric` and keeps
them separate from financial totals, reports, and financial-performance charts.

## Periods and status

Each target has a start date and end date. The Admin form offers annual and
quarterly date presets and also permits a valid custom date range for an
operational target. Targets are `draft`, `active`, or `archived`. Only active
targets appear in dashboard progress views; historical targets and updates
remain available to Admins.

## Revisions and auditability

An active target is never silently overwritten. A change to its goal, dates,
name, metric, or Finance reference creates a successor revision and archives
the old version. All target actions and operational-progress updates retain the
authenticated Admin, timestamp, before/after values where applicable, and the
required reason/reference through database audit records.

## Data model

The existing `financial_targets` table remains the home for approved financial
targets only. A migration will extend it with a target lineage, revision number,
status, and required Finance reference. Its `metric_code` remains limited by
application and database rules to the four approved financial measures above.

The migration will add two separate tables:

- `operational_targets` for custom names, money-or-quantity values, unit or
  USD currency, period, status, and Finance/operational reference; and
- `operational_target_progress_updates` for append-only manual actuals,
  effective dates, evidence notes, and the authenticated actor.

A target edit archives the current revision and inserts a successor in the
same lineage; direct in-place changes to an active definition are rejected.
Database constraints will reject invalid status/value combinations, non-USD
financial target values, empty custom names or quantity units, bad date ranges,
and progress updates for financial targets. Admin RLS remains the only write
path. Approved users may read the published, UI-safe target data through the
existing approved-user read policy.

## Application design

The Finance area will receive a dedicated Targets section/page. It shows a
clear separation between financial and operational targets, an empty state
when none exist, status/loading/error states, and the latest operational
progress plus history where applicable. Admin controls call thin authenticated
API routes. Those routes validate Zod contracts, invoke a target service, and
use a request-scoped Supabase client so RLS and audit triggers identify the
real actor. UI components contain no financial calculation or authorization
logic.

## Actual-value rule

This release deliberately does not calculate financial actuals because the
B2B and B2C source data is not yet complete and reconciled. The later shared
calculation service must use the same verified ledger data for dashboards,
reports, and alerts. It must preserve the separation of cash received,
bookings, and recognised sales.

## Error handling

Invalid requests receive a safe field-level validation message. Unauthorized
users receive no write capability. Database or service failures are surfaced
as a safe error state and do not imply that a target was saved. No update may
partially alter a target definition or operational progress value.

## Tests

Tests will cover validation, Admin-only writes, viewer read-only behavior,
financial-versus-operational separation, target revision history, required
operational evidence, and the rule that incomplete financial coverage is never
presented as a zero actual or manual financial progress.
