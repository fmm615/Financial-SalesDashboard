# Project Structure

The old implementation is isolated from the clean rebuild.

Suggested structure:

```text
/
├── AGENTS.md
├── README.md
├── old-project/              # read-only reference
├── docs/
├── supabase/
│   └── migrations/
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   └── api/
│   ├── components/
│   ├── mocks/                # typed, UI-phase mock datasets only
│   ├── features/
│   │   ├── b2c/
│   │   ├── b2b/
│   │   ├── finance/
│   │   ├── reports/
│   │   ├── admin/
│   │   ├── review-queue/
│   │   └── summit/
│   ├── lib/
│   │   ├── auth/
│   │   ├── motion.ts         # reusable UI motion variants
│   │   ├── supabase/
│   │   ├── validation/
│   │   └── integrations/
│   ├── server/
│   │   ├── services/
│   │   ├── repositories/
│   │   └── jobs/
│   └── types/
└── tests/
```

## Folder rules

### `old-project/`

Read-only reference. Never used as the new application runtime.

### `features/`

Business-domain UI and feature-specific logic.

### `mocks/`

Phase 1 data fixtures are isolated by business area. UI pages compose these typed fixtures and must not hardcode representative financial values inline. Replace fixtures with application/data access layers in a later approved phase without changing presentational components.

### `components/`

Reusable accessible presentation components: application shell, state views, tables, charts, form fields, and detail/history primitives. They contain no provider logic or financial calculations.

### `server/services/`

Business/application operations. Keep API routes thin.

### `server/repositories/`

Database access patterns where a repository abstraction is useful.

### `lib/supabase/` and `lib/validation/`

Request-scoped and trusted-server Supabase client factories live in `lib/supabase/`. Zod write contracts live in `lib/validation/`. Raw generated database rows belong in `types/database.generated.ts`; UI components must consume feature/domain types instead.

### `middleware.ts` and `app/auth/`

`middleware.ts` is the server-side session, allowlist, and route-authorization gate. `app/auth/callback/route.ts` exchanges the Google OAuth code for a Supabase cookie session. Neither contains OAuth client secrets.

### `lib/integrations/`

Provider-specific code and normalization.

### `supabase/migrations/`

All database schema changes.

## Rule

The structure may evolve, but changes must preserve clear ownership and separation of responsibilities and must be documented here.
