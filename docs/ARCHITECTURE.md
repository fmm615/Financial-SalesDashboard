# Architecture

## Goal

Build a secure, reliable and maintainable internal Financial Operating System for PLAYBOOK.

## Approved stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Supabase PostgreSQL
- Supabase Auth
- Supabase Storage
- Vercel

## Architecture principles

### 1. Clear layers

Keep clear boundaries between:

1. UI
2. Application/business logic
3. Data access
4. Database and external providers

UI components must not contain financial business rules.

API routes should validate requests, call the appropriate service, and return a response. They should not become large business-logic files.

### 2. Feature-based organization

Organize code around business areas such as:

- B2C
- B2B
- Finance
- Reports
- Admin
- Review Queue
- Summit

Avoid scattering one feature across unrelated generic folders.

### 3. Shared financial calculation layer

Dashboard values, PDF reports, CSV exports and alerts must use the same calculation logic.

Do not independently reimplement important totals in multiple places.

### 4. External integration boundaries

Stripe, Tap and HubSpot payloads must be validated and normalized before entering the rest of the application.

Provider-specific structures must not spread throughout the codebase.

### 5. Stateless application hosting

Do not use Vercel local filesystem as permanent storage.

Persistent financial data belongs in Supabase PostgreSQL. Generated report files belong in Supabase Storage.

### 6. Background work

Long-running work such as scheduled reports must be represented by persistent job records with states such as:

- pending
- processing
- completed
- failed

The system must never rely on an open browser request to keep a long-running report alive.

## Phase 2 data boundary

Database access now enters through `src/server/repositories/` and validation contracts in `src/lib/validation/`. UI components remain independent from Supabase rows and SQL. User-initiated Admin actions must use a request-scoped authenticated Supabase client so RLS and audit triggers have the individual actor; the service-role client is reserved for future trusted jobs.

## Review Queue boundary

The Review Queue reads retained `review_flags`, `review_flag_resolutions`, and
`review_notes` through a request-scoped repository, a UI-safe service model,
and authenticated API routes. The browser never reads raw provider payloads or
decides whether a financial record is reportable. Approved users may view
flags, notes, and resolution history; only an Admin may add an append-only,
audited note. The queue has no generic browser-side "resolve" action and does
not calculate or alter B2B/B2C financial values.

Suggested actions are source-aware: B2B possible duplicates link to their
existing duplicate-review workflow. B2C payment content duplicates are instead
constructed and resolved by the protected database-group workflow below; a
generic review-flag resolution cannot make an open group reportable.

## B2C payment duplicate boundary

`20260820111000_b2c_payment_duplicate_groups.sql` makes B2C content-duplicate
construction SQL-authoritative. A succeeded payment write (including a verified
local correction) can open or extend one immutable payment duplicate group from
effective e-mail, USD amount, category, business date, and the approved 48-hour
window. Stripe and Tap repositories retain provider transaction-ID idempotency
and ordinary data-quality flags, but never query for content candidates or
write `possible_duplicate` flags themselves.

Group and member history is immutable. An open group blocks every member from
reporting; an Admin supplies an auditable reason and atomically chooses
`keep_all` or `keep_one`. `keep_all` includes every member, while `keep_one`
includes exactly the selected member; any resolved exclusion takes precedence
over a later include. Safe reporting-state booleans are available without group
membership, while group membership and decision writes are Admin-only through
request-scoped authenticated clients and protected RPCs. The guarded historical
backfill preserves unprovable flags for review, and only a stale orphan flag
with no current candidate can be dismissed.

Payment duplicate groups contain only `b2c_payments`. They are the one B2C
content-duplicate mechanism now that the Payment Tracker workbook's own exact
cross-tab grouping has been removed (see the B2C Finance reconciliation
boundary below); Manual Bank Transfer's 48-hour content-duplicate check also
runs through this same trigger, not a separate one.

## Targets boundary

The Targets feature keeps approved financial goals distinct from operational
goals and their manually entered progress. Financial target actuals are not
stored or entered by an Admin: they will be calculated only from verified,
reconciled B2B and B2C source records. Until that source history is complete,
the UI states `Actuals not fully loaded` rather than treating missing data as
zero.

Operational targets may be a USD money goal or a quantity with a unit. Their
progress entries are append-only, require an effective date and evidence note,
and never feed financial totals, reports, or financial-performance charts.
Admin target writes use a request-scoped authenticated client, RLS, actor and
audit triggers. A target revision is an atomic database action that archives
the active definition and creates its successor in the same lineage; an active
target cannot be overwritten in place.

## B2C Finance reconciliation boundary

The entire Payment Tracker Excel-workbook system has been removed: workbook
upload/parsing, the Finance staging tables, exact cross-tab duplicate grouping
between the `B2C`/`B2C Cons` tabs, lineage tracking and canonicalization,
Finance staging-row corrections/date-authority actions, and the posting of
approved iOS/bank-transfer rows into `b2c_payments`. Stripe Charges and Tap
statement CSV upload/evidence staging were removed earlier for the same
reason: Stripe's and Tap's own APIs are now the sole source of truth for those
two providers, and the sheet is no longer cross-referenced against them at
all. `supabase/migrations/20260901100000_remove_payment_tracker_sheet_system.sql`
is the single migration that drops every table, view, function, trigger, and
enum type this system owned; every earlier migration file that created those
objects is left untouched, per the project's additive-only migration history.

There is an intentional functionality gap here: iOS and bank-transfer
ingestion has no working intake path until the product owner designs and
builds a new one. Historical `b2c_payments` rows with
`source_system = 'finance_tracker'` (posted before this removal) are not
deleted -- they remain fully reportable ledger history, labelled Finance — iOS
or Finance — Bank transfer, with their original provenance preserved in each
row's own `source_metadata`. No new `finance_tracker` payment can ever be
created again.

Manual Bank Transfer entry is unaffected apart from one narrowed check (see
below): it remains the one way to record a genuinely new bank transfer
directly into `b2c_payments`, with its own audited duplicate checks.

Stripe API enrichment remains one-to-one with the existing B2C payment. The
Charge ID is the payment identity; PaymentIntent, Checkout, Invoice, Payment
Method, Customer, and Balance Transaction objects add typed evidence and never
create another sale. Charge, completed-Checkout, and finalized-Invoice contacts
are transaction evidence. Mutable Payment Method and Customer contacts are
stored separately and exposed to approved users only through a narrow protected
function with explicit source labels. Settlement, fee, conversion, and tax
evidence is retained separately and never enters dashboard totals. Approved
users may inspect a deliberately narrow, read-only list of source fields in B2C
Operations; raw provider payloads, payment-method data, and card data never
leave the Admin-only boundary.

When a Stripe or Tap source transaction is non-USD, its original amount remains
visible in the operating ledger but it has no USD reporting value at ingestion.
An Admin must use the narrow Finance FX-conversion API to supply an approved
USD-per-unit rate, source, effective date, and audit reason. The security-
definer database routine calculates the local USD value from the immutable
source amount, appends conversion history, and does not call a provider. The
generic B2C local-correction path is intentionally unable to create a USD
amount for a foreign source record.

B2C exposes one accurate decision and work-item layer on top of everything
above. `src/lib/b2c/payment-decision.ts` translates the approved
`b2cPaymentExclusionReasons` financial gate into a richer `B2cPaymentDecision`
-- independent `sourceStatus`, `reconciliationStatus`, `reportingDecision`, and
`postingStatus` facts, plus a detailed `B2cBlockingReason` list -- without
loosening or duplicating a rule the gate already enforces. `sourceSystem`
still includes `finance_tracker` and `postingStatus`/`financeLineageStatus`
are still resolved, purely to represent already-posted historical
Finance-Tracker ledger rows accurately (always `"posted"`); no live code path
can ever produce any other `financeLineageStatus`. A refund's own decision
never overwrites its linked payment's `sourceStatus`.
`src/server/services/b2c-work-items.ts` turns unresolved blocking reasons into
detailed internal `B2cWorkItem` queues (`data_quality`, `duplicate`, `fx`,
`reconciliation`, `source_failure`), which `b2c-workspace-repository.ts`
groups into the three visible Work queue filters (`data`, `duplicates`,
`reconciliation`). `b2c-ledger-repository.ts` adds the paged, filtered, sorted
ledger read the workspace needs, decorating rows from the existing dashboard
snapshot rather than re-querying B2C sources. `b2c-dashboard-repository.ts`
remains the one compatibility facade underneath both.

The shared record drawer (`b2c-payment-review-drawer.tsx`) is the one place
every B2C correction, FX conversion, Finance exception, refund FX, and
payment-duplicate decision is reachable from -- Work queue and Ledger both
open it, and it owns opening, closing, focus, errors, and refresh; there is no
separate per-row dialog. It picks one primary action from a work item's
`nextAction` (or, for a full ledger row, the same reason-to-action mapping
applied to the row's own decision) and renders every other available action
under "More actions". Because `/api/b2c/workspace` never carries
`stripeEvidence`, the drawer's Source evidence panel reads full Stripe
evidence itself, only for an Admin, through a dedicated
`/api/admin/b2c/payments/[paymentId]/evidence` route built on the same
dashboard snapshot. Provider descriptions are source evidence and the visible
product label; optional local category/tier metadata does not enter the
reportability decision. The retained `unmapped` value stays inside the
duplicate fingerprint only, never as a Work-queue, Ledger-issue, Review-Queue,
or drawer mapping action.

## Authentication boundary

Supabase OAuth redirects through `src/app/auth/callback/route.ts`; App Router middleware refreshes sessions and performs the approved-user/role route gate before protected pages render. Browser, server, and request-scoped clients remain in `src/lib/supabase/` so session handling stays out of UI features.
