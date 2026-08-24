# Task 7 remediation report — retired unmapped-product flag history

## Root cause

The latest nine-argument definition of
`public.apply_b2c_payment_local_correction` was in
`20260820111000_b2c_payment_duplicate_groups.sql`. Its
`p_category_code is not null` branch inserted a resolved
`review_flag_resolutions` row for every open historical
`unmapped_product` flag on that payment. This changed retired mapping audit
history during an otherwise valid local metadata correction, contrary to the
approved rule that those flags are read-only retained history.

## Forward repair

`20260824151000_preserve_retired_unmapped_product_flag_history.sql` follows
`20260824150000_retire_b2c_product_mapping_requirement.sql` and replaces the
latest nine-argument local-correction function. It preserves the signature,
`SECURITY DEFINER`, `search_path`, Admin authorization, validations, workflow
mutex and row locks, financial-correction audit, local category metadata,
missing-email resolution, owner/grant behavior, and every other branch. It
removes only the legacy `unmapped_product` resolution branch.

## RED / GREEN regression

The pgTAP regression performs a genuine authenticated Admin local category
correction on a payment with an open historical `unmapped_product` flag.

- RED before the new migration: test 151 reported `resolved` instead of
  `open`; test 152 found one resolution instead of zero. The local override
  and financial-correction audit assertion passed.
- GREEN after local reset applied the new migration:

```text
$ npm run supabase:test
Files=1, Tests=153
Result: PASS
```

The test now proves the flag remains open, no resolution row is inserted, and
the category override plus financial-correction audit remain persisted.

## Verification

```text
$ npm test
Test Files  68 passed (68)
Tests  564 passed (564)

$ npx tsc --noEmit
exit 0

$ npm run lint
exit 0

$ git diff --check
exit 0
```

## Commit

Pending commit.

## Manual application

Do not run `supabase db push` and do not apply either migration remotely from
Codex. After merged code is deployed, manually run these files in Supabase SQL
Editor, in this order, and confirm both succeed before relying on the behavior:

1. `supabase/migrations/20260824150000_retire_b2c_product_mapping_requirement.sql`
2. `supabase/migrations/20260824151000_preserve_retired_unmapped_product_flag_history.sql`
