# Task 7 report — optional provider product category

## Delivered

- Updated the current B2C business, architecture, database, integration, and
  Stripe setup documentation to make provider descriptions the visible source
  label and Stripe/Tap category/tier optional local metadata.
- Documented that `unmapped` remains the duplicate-fingerprint value, not a
  reportability gate; mapping history is retained read-only; and no mapping
  workflow remains in B2C Work, Ledger issues, generic Review Queue, or the
  shared drawer.
- Documented the Finance-exception category removal while preserving every
  remaining guard, and explicitly preserved manual bank-transfer and Finance
  Tracker category requirements.
- Added dated supersession/amendment notes without rewriting the historical
  requirements reference or completed-plan checklists.
- Renamed the stale Task 1 decision-test wording from “mapped payment” to
  “provider payment.”

## Fresh verification

The final local reset applied
`20260824150000_retire_b2c_product_mapping_requirement.sql` to the local
database only and completed with `Restarting containers...`.

```text
$ npm run supabase:test
.../supabase/tests/database_foundation.test.sql .. ok
All tests successful.
Files=1, Tests=150,  1 wallclock secs
Result: PASS

$ npm test
Test Files  68 passed (68)
     Tests  564 passed (564)

$ npx tsc --noEmit
# exit 0

$ npm run lint
> eslint src tests
# exit 0

$ npx vitest run [the nine Task 7 focused files]
Test Files  9 passed (9)
     Tests  135 passed (135)
```

`git diff --check` exited 0. Final ownership scans found no live mapping
route/action/RPC caller or `product_mappings` owner in `src/`; remaining
`unmapped_product` matches are generated typing, historical exact-detail
typing/labels, explicit live-list filtering, and regressions. The migration
filename occurs exactly once under `supabase/migrations`. No `old-project/`
files changed. `tsconfig.tsbuildinfo` remained the pre-existing unrelated
unstaged modification.

## Manual database action

**Do not run `supabase db push` and do not apply a remote migration
automatically.** After the merged code is deployed, the user must run
`supabase/migrations/20260824150000_retire_b2c_product_mapping_requirement.sql`
in Supabase SQL Editor, then confirm that migration succeeds before relying on
the new optional-category behavior.
