# Development Workflow

## Before coding

1. Read `AGENTS.md`.
2. Read the relevant business and engineering docs.
3. Understand the requested feature and its business rule.
4. Check whether a database migration is required.
5. Identify security and test requirements before implementation.

## During implementation

- Keep changes focused.
- Do not modify `old-project/`.
- Do not copy old architecture by default.
- Keep APIs thin.
- Validate external inputs.
- Add audit behavior for manual financial changes.
- Add tests for critical behavior.

## Database changes

- Create a migration.
- Do not rely on manual table-editor changes.
- Review constraints and indexes.
- Consider historical/audit implications.

## Feature completion checklist

Before marking a feature complete:

- TypeScript passes.
- Lint passes.
- Relevant tests pass.
- Authorization is enforced server-side.
- Database migrations are included where needed.
- Errors are handled explicitly.
- No secrets are exposed.
- No debug code remains.
- Relevant docs are updated.

## Pull request / change summary

For meaningful changes, summarize:

- what changed
- why
- business rule affected
- database changes
- security impact
- tests added/run
- known limitations

## Business-rule uncertainty

If a financial rule is unclear, do not invent an answer.

Stop and request clarification before implementing behavior that could change financial totals.
