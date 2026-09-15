# Task 5 Report — Hide Retired Product-Mapping Flags from the Live Review Queue

## Scope

Implemented Task 5 only. Historical `unmapped_product` review flags are excluded
from the generic live Review Queue list and all list-derived metrics, while an
exact retained flag ID still returns its read-only detail and audit history. No
source history, B2C dashboard/Ledger projection, Admin mapping workflow,
database permissions, or migration was changed.

## RED evidence

Before production edits, ran
`npx vitest run tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts`.
The first test-only draft used JSX in a `.ts` file and was corrected before
production code changed. The valid RED run then produced four intended behavior
failures: `flagType=unmapped_product` was accepted; the live filter offered
`Unmapped product`; service list/metrics included a retained flag; and the
authenticated list API likewise included it. Exact-detail retention regressions
passed in RED because that historical read path was intentionally preserved.

## GREEN and verification evidence

Focused GREEN: `npx vitest run tests/review-queue-contracts.test.ts
tests/review-queue-api.test.ts` passed 2 files and 18 tests.

`npm run typecheck`, `npm run lint`, `npm test`, and `git diff --check` passed.
The full Vitest suite passed 68 files and 564 tests. Vitest emitted only the
pre-existing Vite CJS deprecation notice and Node `localStorage` experimental
warnings.

## Changed files

- `src/server/services/review-queue.ts`: narrow live-filter type and a
  defense-in-depth filter before items and metrics.
- `src/server/repositories/review-queue-repository.ts`: list-only
  `neq("flag_type", "unmapped_product")`; exact detail still queries by ID.
- `src/lib/validation/review-queue-contracts.ts` and
  `src/features/review-queue/review-queue-page.tsx`: removed the retired live
  filter value while retaining the historical label mapping.
- `tests/review-queue-contracts.test.ts` and `tests/review-queue-api.test.ts`:
  contract/UI, service/API projection, metric, and exact-detail regressions.

## Migration status

No migration was required, created, or modified. Task 6 remains the sole owner
of the mapping-retirement permission migration.

## Commit

`refactor(review): hide retired product mapping flags`

`b22bd0523df000ac46cc03efc3d30220f2ea4040`
