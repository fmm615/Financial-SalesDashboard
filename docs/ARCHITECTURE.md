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
existing duplicate-review workflow, while B2C possible duplicates remain open
until Finance defines an explicit audited keep/exclude workflow. The generic
B2C resolution RPC rejects an open possible-duplicate flag so an ordinary
queue action cannot accidentally make a payment reportable.

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

Finance workbook reconciliation is a separate staging boundary, not an
alternative B2C payment ledger. Only the `B2C` and `B2C Cons` tabs of the
Finance Payment Tracker are accepted as USD revenue candidates, and their
amounts exclude customer VAT. The original file hash, private Storage location,
tab, one-based row number, raw cells, parsed values, quality issues, and actor
are retained. Staging itself never writes to `b2c_payments` or a reportable
view. The separately protected approved-Finance posting path below is the only
exception, and it can post only the already approved iOS/bank-transfer rows.

Stripe Charges and Tap statements are payment evidence only. They may be linked
to a Finance candidate during reconciliation, but never create a second Finance
revenue row. Tap statement amounts remain in their original BHD currency; the
application never invents a BHD-to-USD rate. Provider fees, fee VAT, transfers,
opening balances, refunds, and unrecognised statement lines are retained with
their own evidence kind and cannot be sales.

Source dates are parsed only when ISO, unambiguous `dd/mm/yyyy`, or a known
Excel serial. A declared month/year disagreement creates a review issue; the
application never swaps day/month or silently repairs the date. Exact source
file hashes cannot be imported twice. Duplicate candidates, conflicts,
zero-value rows, missing fields, and invalid rows remain staged and non-reportable
until Finance makes an audited decision. A completed Finance import is stored
atomically through a protected database function, rather than a sequence of
browser writes.

An Admin may upload the original Payment Tracker `.xlsx` only through the
controlled B2C reconciliation workflow. The server validates and parses the
two approved tabs, previews only safe quality counts, re-hashes the confirmed
file, stores it in the private `b2c-finance-imports` bucket, and then invokes
the atomic staging function. Storage policies permit only Admin access; no
Viewer, anonymous user, or public URL can read the source workbook. Tap and
Stripe evidence use separate future upload boundaries.

Tap statements follow the same private-upload control but stage into provider
evidence rather than Finance revenue candidates. Every source line is retained
with its Tap kind and original currency, through an atomic Tap finalizer. No
Tap upload can write a reportable payment or invent a BHD-to-USD rate.

Stripe Charges CSV files use the same private staging boundary. A direct
Stripe refund is retained as a second, linked evidence entry with an explicit
source-entry key, so the original charge evidence remains intact. Typed source
name, email, and phone fields are Admin-only; card, address, fingerprint, IP,
payment-method, and metadata values are retained only in the private original
file. This path does not create a B2C payment, USD conversion, or revenue total.

The coverage API is deliberately safe for approved viewers: it exposes only
source states and counts, never raw row data, provider IDs, or customer details.
It always reports `Not fully loaded` until the complete Stripe Charges export,
the required evidence, reconciliation, and a later Finance approval workflow
exist. It does not calculate or display a B2C Finance revenue total.

Exact cross-tab grouping is an Admin-only, review-first step after a completed
Payment Tracker import. It creates a group only for one valid `B2C` row and one
valid `B2C Cons` row with the exact normalized customer name, date, USD amount,
and payment method. The tabs' category and contact fields are not equivalent,
so they remain Admin review context rather than cross-tab matching keys.
Repeated keys are ambiguous and never grouped automatically. Both rows remain
immutable, and the reasoned canonical/excluded decision stays outside
reportable payments and Finance period approval.

Approved Finance iOS and bank-transfer rows have a narrow, separate ledger
path. The protected transaction selects only valid, positive, dated tracker
rows with those exact payment methods, preserves their source tab/row/import
provenance, and creates one `finance_tracker` B2C payment plus one immutable
ledger-post link. A `B2C`/`B2C Cons` duplicate group contributes only its
canonical row; excluded or undecided groups contribute none. The tracker’s USD
amount is retained as gross revenue excluding VAT—no Tap/Stripe fee, VAT,
settlement, Apple aggregate proceeds, or FX value is inferred. The Admin’s
posting action is the Finance approval for this limited source, so a missing
e-mail remains visible but does not exclude the linked Finance payment by
itself. All other reportability blocks remain active. Those rows are labelled
Finance — iOS or Finance — Bank transfer and never claim a provider match.

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

Posted Finance payments remain immutable after posting. An Admin amount or
business-date correction is represented by signed rows in the append-only
`b2c_finance_ledger_adjustments` stream, linked to the original payment and
Finance source row. The effective ledger view adds those entries without
rewriting provider evidence or the posted payment. The browser uses the
expected-state RPC wrapper, so a stale Admin tab is rejected and must reload;
retries are idempotent by adjustment request ID. All adjustment reasons and
actors are written to the audit history, and the original source remains
visible for traceability.

Approved Finance posting is keyed by stable lineage identity, not by raw
staging row. The same real payment can span several staging rows across
different workbook versions; posting resolves each confirmed lineage to its
current linked row and inserts at most one Finance payment per lineage, ever.
A lineage already represented by an existing manual bank transfer is
permanently excluded from this path, so it is never eligible for a second
payment; an admin-confirmed revision to an already-posted lineage must go
through the append-only posted-adjustment path above instead of a new post.

B2C exposes one accurate decision and work-item layer on top of everything
above. `src/lib/b2c/payment-decision.ts` translates the approved
`b2cPaymentExclusionReasons` financial gate into a richer `B2cPaymentDecision`
-- independent `sourceStatus`, `reconciliationStatus`, `reportingDecision`, and
`postingStatus` facts, plus a detailed `B2cBlockingReason` list -- without
loosening or duplicating a rule the gate already enforces. Statement/provider
evidence and Finance-lineage posting state are resolved as additional,
independent dimensions rather than passed through the financial gate, and a
refund's own decision never overwrites its linked payment's `sourceStatus`.
`src/server/services/b2c-work-items.ts` turns unresolved blocking reasons into
detailed internal `B2cWorkItem` queues (`data_quality`, `duplicate`, `fx`,
`mapping`, `reconciliation`, `source_failure`), which `b2c-workspace-repository.ts`
groups into the four visible Work queue filters (`data`, `duplicates`,
`reconciliation`, `ready_to_post`); Ready-to-post is always one aggregated item
sourced from Task 2's `summarizeFinancePostingReadiness`, never one row per
lineage. `b2c-ledger-repository.ts` adds the paged, filtered, sorted ledger
read the workspace needs, decorating rows from the existing dashboard snapshot
rather than re-querying B2C sources. `b2c-dashboard-repository.ts` remains the
one compatibility facade underneath both.

The shared record drawer (`b2c-payment-review-drawer.tsx`) is the one place
every B2C correction, mapping, FX conversion, Finance exception, refund FX,
Finance-Tracker duplicate decision, and posted-Finance adjustment is reachable
from -- Work queue and Ledger both open it, and it owns opening, closing,
focus, errors, and refresh; there is no separate per-row dialog. It picks one
primary action from a work item's `nextAction` (or, for a full ledger row, the
same reason-to-action mapping applied to the row's own decision) and renders
every other available action under "More actions". `adjust-b2c-finance-
payment.ts` is the thin service the drawer's posted-adjustment action calls:
it looks up the linked Finance row, reads back the current effective balance
by replaying the payment plus its append-only adjustment history, and always
calls the expected-state RPC above -- the browser only ever sends the values
it currently believes are true plus the corrected value, never a signed
adjustment row. Because `/api/b2c/workspace` never carries `stripeEvidence`,
the drawer's Source evidence panel reads full Stripe evidence itself, only for
an Admin, through a dedicated `/api/admin/b2c/payments/[paymentId]/evidence`
route built on the same dashboard snapshot.

## Authentication boundary

Supabase OAuth redirects through `src/app/auth/callback/route.ts`; App Router middleware refreshes sessions and performs the approved-user/role route gate before protected pages render. Browser, server, and request-scoped clients remain in `src/lib/supabase/` so session handling stays out of UI features.
