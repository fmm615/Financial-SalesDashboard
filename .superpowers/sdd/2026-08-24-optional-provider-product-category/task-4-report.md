# Task 4 Report — Remove the Admin Provider-Mapping Workflow

## Scope

Implemented Task 4 only: the Admin mapping API request contract, route, and
shared-drawer mapping action are removed. Historical mapping records and audit
history are untouched. The separate database permission/function migration is
owned by Task 6 and was not created here.

## RED evidence

Before production edits, ran:

```text
npx vitest run tests/b2c-payment-review-drawer.test.tsx tests/b2c-product-mapping-retirement.test.ts
```

Result: 2 tests failed as intended because `Create reusable product mapping`
still rendered for an unmapped provider record. The regressions were corrected
for test syntax only and rerun; the same two behavior assertions again failed
for that live mapping control before the production removal.

## GREEN and verification evidence

Focused GREEN run:

```text
npx vitest run tests/b2c-payment-review-drawer.test.tsx tests/b2c-product-mapping-retirement.test.ts
```

Result: 2 files passed, 13 tests passed.

Additional verification:

```text
npm test
npm run typecheck
npm run lint
git diff --check
```

Result: 68 Vitest files passed with 559 tests; TypeScript passed; lint passed;
and `git diff --check` returned no errors. Vitest emitted only the existing
Vite CJS deprecation notice and Node `localStorage` experimental warnings.

The final ownership scan confirmed that the deleted route does not exist and
there are no application callers of the deleted schemas, mapping API, mapping
submission, mapping labels, or private drawer `map` branch.

## Changed files

- Deleted `src/app/api/admin/b2c/products/map/route.ts`
- Removed mapping schemas and inferred types from
  `src/lib/validation/financial-contracts.ts`
- Removed mapping-only UI state, submission, action types, and drawer branch
- Made the missing-email Finance-exception UI category-independent while
  retaining its confirmations and required reason
- Removed stale Admin Stripe-sync mapping copy
- Added observable shared-drawer retirement regressions

## Migration status

No migration required or created for Task 4. Task 6 owns the forward migration
that revokes the retained database mapping-write permissions and relaxes the
database Finance-exception category guard.

## Commit

`refactor(b2c): remove provider mapping workflow`
