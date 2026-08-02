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

## Authentication boundary

Supabase OAuth redirects through `src/app/auth/callback/route.ts`; App Router middleware refreshes sessions and performs the approved-user/role route gate before protected pages render. Browser, server, and request-scoped clients remain in `src/lib/supabase/` so session handling stays out of UI features.
