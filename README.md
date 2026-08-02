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

## Database migrations

All database changes must be represented in `supabase/migrations/` and committed to Git.

## Authentication

The intended login method is Google Sign-In through Supabase Auth, restricted to approved PLAYBOOK users.

## Tests

Critical financial calculations, integrations and authorization flows must be covered by automated tests.

## Deployment

- Application: Vercel
- Persistent database: Supabase PostgreSQL
- Report/file storage: Supabase Storage

Deployment must never depend on local filesystem persistence for financial records.
