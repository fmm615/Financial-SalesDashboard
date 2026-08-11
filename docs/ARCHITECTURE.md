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

## Authentication boundary

Supabase OAuth redirects through `src/app/auth/callback/route.ts`; App Router middleware refreshes sessions and performs the approved-user/role route gate before protected pages render. Browser, server, and request-scoped clients remain in `src/lib/supabase/` so session handling stays out of UI features.
