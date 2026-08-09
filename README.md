# PLAYBOOK Financial Operating System

Clean rebuild of PLAYBOOK's internal Sales & Reporting Dashboard.

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Supabase PostgreSQL
- Supabase Auth
- Supabase Storage
- Vercel

## Important

`old-project/` is reference material only. See `AGENTS.md` before making changes.

## Engineering documentation

See `docs/` for:

- architecture
- coding standards
- security
- database rules
- approved business rules
- testing
- error handling
- integrations
- project structure
- development workflow

## Environment variables

Document variable names here as integrations are configured. Never place real secret values in this file.

Expected categories include:

- Supabase URL/public key
- server-only Supabase credentials where required
- Stripe credentials
- Tap credentials
- HubSpot credentials
- email provider credentials
- cron/job security values

Only values intentionally safe for browser use may be public.

## UI foundation (Phase 1)

The initial frontend framework is now available with typed mock data only. It includes the Executive, B2C, B2B, Finance, Reports, Review Queue, Admin, Audit Log, login, access-denied, and session-loading routes. No authentication, database, provider integration, report generation, or financial writes are implemented.

See [UI_SYSTEM.md](docs/UI_SYSTEM.md) for UI principles and component guidance.

## Local development

```bash
npm install
npm run dev
```

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before review.

## Database foundation (Phase 2)

Supabase migrations, RLS, fake local seed data, validation contracts, repository boundaries, and a raw database-type snapshot now live in this repository. The UI remains mock-driven while provider data access is introduced feature by feature. Google Sign-In is connected. HubSpot has a server-only, validated webhook and reconciliation foundation; it must be configured and verified against the real portal before it supplies dashboard data. Report generation, email, and scheduled execution remain unconnected.

Read [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) before changing the schema. The two roles are `admin` and `viewer`; every user-initiated write is Admin-only and audited.

### Run Supabase locally

1. Start Docker Desktop.
2. Copy `.env.example` to `.env.local` only when connecting an application later; do not add real secrets to Git.
3. Run `npm run supabase:start`.
4. Run `npm run supabase:reset` to apply every migration and the fake local seed.
5. Run `npm run supabase:types` to regenerate `src/types/database.generated.ts`.
6. Run `npm run supabase:test`, then the normal TypeScript, lint, test, and build checks.

`supabase/seed.sql` is development-only and contains no usable credentials.

## Authentication

The intended login method is Google Sign-In through Supabase Auth, restricted to approved PLAYBOOK users.

The OAuth callback, cookie-session middleware, allowlist role lookup, and server-side Admin/Viewer route protection are implemented. Complete the external configuration and real-email allowlist in [GOOGLE_AUTH_SETUP.md](docs/GOOGLE_AUTH_SETUP.md).

## HubSpot B2B integration

The clean HubSpot integration preserves provider IDs, explicitly maps stages and fields, writes a booking only for closed-won deals, and never derives recognised sales. Configure it using [HUBSPOT_SETUP.md](docs/HUBSPOT_SETUP.md) before enabling a webhook or scheduled reconciliation.

## Tap B2C integration

Tap is a read-only B2C provider integration. Configure its server-only key, local mappings, historical backfill, and optional signed webhook using [TAP_SETUP.md](docs/TAP_SETUP.md).

## Tests

Critical financial calculations, integrations and authorization flows must be covered by automated tests.

## Deployment

- Application: Vercel
- Persistent database: Supabase PostgreSQL
- Report/file storage: Supabase Storage

Deployment must never depend on local filesystem persistence for financial records.
