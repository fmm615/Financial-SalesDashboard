# PLAYBOOK FOS - Codex Working Rules

This repository contains a clean rebuild of the PLAYBOOK Financial and Sales Dashboard.

## Old project rule

The folder `old-project/` contains the previous implementation.

- Treat `old-project/` as read-only reference material.
- Do not modify files inside it.
- Do not import code from it into the new application unless explicitly approved.
- Do not copy its architecture, authentication, database, deployment, or scheduling patterns by default.
- Use it only to understand existing features, calculations, provider fields, UI ideas, and historical behavior.

## Required reading before changing code

Read and follow these documents:

1. `docs/BUSINESS_RULES.md`
2. `docs/ARCHITECTURE.md`
3. `docs/CODING_STANDARDS.md`
4. `docs/SECURITY.md`
5. `docs/DATABASE_RULES.md`
6. `docs/TESTING_STRATEGY.md`
7. `docs/ERROR_HANDLING.md`
8. `docs/INTEGRATIONS.md`
9. `docs/PROJECT_STRUCTURE.md`
10. `docs/DEVELOPMENT_WORKFLOW.md`

If a task conflicts with an approved business rule, stop and flag the conflict instead of silently changing the rule.

## Core engineering rules

- Correctness over speed.
- Security is mandatory from the beginning.
- Financial records must be traceable to their source.
- Keep pipeline, bookings, cash received, recognised sales/revenue, refunds, and adjustments separate.
- Do not silently guess missing financial values.
- Missing data is not zero.
- Keep functions, files, services, and components focused on one responsibility.
- Keep API handlers thin; business logic belongs in services/domain modules.
- Validate all external input.
- Never expose or log secrets.
- Add or update tests when changing critical financial behavior.
- Update relevant documentation when architecture, schema, setup, or integration behavior changes.
- Do not leave unexplained TODOs in critical code.

## Completion standard

Before considering work complete:

- TypeScript passes.
- Linting passes.
- Relevant tests pass.
- Security checks are enforced server-side.
- No debug code or hardcoded secrets remain.
- Any database change has a migration.
- Relevant docs are updated.
