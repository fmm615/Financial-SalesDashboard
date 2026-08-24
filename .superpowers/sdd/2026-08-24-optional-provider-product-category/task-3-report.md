# Task 3 Report — Retire unmapped-product dashboard and Ledger artifacts

## Status

Implemented Task 3 only. Historical `unmapped_product` review-flag rows remain untouched; the live B2C dashboard and Ledger projections now omit them.

## RED evidence

Added behavior regressions before production changes for:

- succeeded Stripe and Tap payments with `category_code = "unmapped"` and a historical open `unmapped_product` flag: reportable totals and source description remain present, but the row has no live issue or review flag and does not increase live review counts;
- rejection of `issue=Unmapped%20product` with HTTP 422 while every remaining live Issue value is accepted; and
- removal of unmapped-product copy from `Why totals differ` and from Ledger filters.

Focused RED command:

```text
npx vitest run tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-tap-statement-unmatched-ledger.test.tsx tests/b2c-workspace-ui.test.tsx tests/b2c-workspace-api.test.ts
```

Result: expected RED — 3 files failed and 1 passed; 4 tests failed and 43 passed. Failures showed historical flags still counted as live review work, the retired issue query being accepted, and the remaining UI copy/filter.

## GREEN evidence

The dashboard repository filters `unmapped_product` flags before building all live flag groups, row issues, open-review-flag arrays, and counts. The public ledger issue/query and calculation contracts no longer contain the retired value/count. `B2cOpenReviewFlag` retains its temporary legacy `"Unmapped product"` member for Task 4's mapping drawer type compatibility.

Focused GREEN command:

```text
npx vitest run tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-tap-statement-unmatched-ledger.test.tsx tests/b2c-workspace-ui.test.tsx tests/b2c-workspace-api.test.ts
```

Result: 4 files passed, 47 tests passed.

Additional verification:

```text
npm test                 # 67 files passed, 555 tests passed
npm run typecheck        # passed
npm run lint             # passed
git diff --check         # passed
```

Vitest emitted only the pre-existing Vite CJS deprecation and Node `localStorage` experimental warnings.

## Changed files

- `src/server/repositories/b2c-dashboard-repository.ts`
- `src/lib/validation/b2c-workspace-contracts.ts`
- `src/features/b2c/b2c-workspace.tsx`
- `src/mocks/b2c.ts`
- `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- `tests/b2c-tap-statement-unmatched-ledger.test.tsx`
- `tests/b2c-workspace-ui.test.tsx`
- `tests/b2c-workspace-api.test.ts`

## Migration status

No migration required or created. This task changes only live TypeScript projections and contracts; it does not alter database rows or history.

## Commit

`58491f6a4b7805f86a9b04e251ed86da8f1a6c73` — `refactor(b2c): retire unmapped ledger issues`

## Review follow-up — round 1

Added the missing visible-Ledger regression for a provider row with
`sourceDescription: null`. It asserts that the Description cell renders `—`
rather than category or product-reference fallback data.

```text
npx vitest run tests/b2c-workspace-ui.test.tsx
```

Result: 1 file passed, 29 tests passed. Typecheck, lint, and `git diff --check`
were rerun before the follow-up commit.

## Review follow-up — round 2

Added a compact/mobile-card regression for a provider row with
`sourceDescription: null`. The RED run confirmed the card omitted the
description block entirely. The card now always renders the description line
as `sourceDescription ?? "—"`, while keeping the seller-message line
conditional and unchanged.

```text
npx vitest run tests/b2c-workspace-ui.test.tsx
```

RED result: 1 test failed and 29 passed; the compact `sm:hidden` card lacked
the `—` fallback. GREEN result: 1 file passed, 30 tests passed. Typecheck,
lint, and `git diff --check` were rerun before the follow-up commit.
