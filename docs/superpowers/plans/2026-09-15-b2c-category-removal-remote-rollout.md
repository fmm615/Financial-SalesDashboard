# B2C Category Removal — Remote Rollout Runbook

> **STATUS: NOT EXECUTED. DOCUMENTATION ONLY.**
>
> Nothing in this file has been run against the real remote Supabase project. It was written
> after merging `remove-b2c-category-concept` into `remove-payment-tracker-sheet-system`
> (merge commit `c2bafd9`) and validated **only** against a local `supabase db reset --local`
> database. A human must run these steps deliberately, in order, reading each one first.

**Goal:** apply the category-removal migration to the remote database, discard the ~1090 already-imported
B2C payments/refunds, and re-run the Stripe and Tap historical backfills from scratch so every row is
computed with the new, category-free duplicate-fingerprint algorithm — rather than backfilling stale
fingerprint values in place.

**Why a wipe-and-reimport rather than a fingerprint backfill:** `duplicate_fingerprint` is derived at
ingestion time. Rewriting it in place for existing rows would have to reproduce the exact ingestion
inputs from stored columns, which is fragile and silently wrong if any input was not persisted.
Re-importing regenerates the value from the provider payload, which is the authoritative source.

---

## Pre-flight

- [ ] The merge is on the working branch and verified locally: typecheck clean, eslint clean,
      vitest 349/349, `supabase db reset --local` applies all 6 migrations, pgTAP 55/55.
- [ ] Take a backup / PITR checkpoint of the remote project **before** step 2. Step 2 is destructive
      and irreversible without one.
- [ ] Do this during a quiet window. Between step 2 and the end of step 4 the B2C dashboard will
      report "not loaded" and show no B2C totals. That is expected, not a bug.
- [ ] Confirm the CLI is linked to the intended project: `supabase projects list` and check which
      row is marked linked. Do not proceed if it points anywhere unexpected.

---

## Step 1 — Apply the migration to remote

```bash
supabase db push --linked
```

**Check before proceeding:** the output must list `20270101000500_remove_b2c_category.sql` as applied
and finish with no error. If it reports any other pending migration you did not expect, stop and
investigate — the remote history should differ from local only by this one file.

---

## Step 2 — Wipe the imported B2C payment data (DESTRUCTIVE)

Run in the Supabase SQL Editor (or `psql`) as a role that bypasses RLS. It is one transaction: it
either fully succeeds or fully rolls back.

### Read this before running

The naive delete order does **not** work. Three things about this schema make it more involved than
"delete the details, then delete the payments":

1. **`b2c_payments` has nine dependent tables, not two.** `b2c_payment_fx_conversions` and
   `b2c_refund_fx_conversions` are `ON DELETE RESTRICT`; all the others are `NO ACTION`. Every one
   must be cleared explicitly or the transaction aborts on an FK violation.
2. **`audit_events` has NO foreign key to payments or refunds.** It is a loose pair of
   `area text` + `record_id uuid`, and `area` holds the *table* name written by the
   `write_audit_event` trigger (`tg_table_name`) — so the values are `'b2c_payments'` /
   `'b2c_refunds'` (plural), **not** the `'b2c_payment'` / `'b2c_refund'` (singular) values used by
   `review_flags.source_area` and `financial_corrections.target_area`. Do not mix them up.
3. **The audit triggers fire on DELETE.** Deleting payments inserts a fresh `audit_events` row per
   deleted payment. The audit cleanup must therefore come **last**, after the payment deletes, or it
   leaves behind a full set of new `delete` rows.

```sql
begin;

-- Captured before the flag rows are deleted, so the audit cleanup at the end can still scope itself.
create temporary table _wipe_flag_ids on commit drop as
  select id from public.review_flags where source_area in ('b2c_payment', 'b2c_refund');

-- refund-side dependents (b2c_stripe_refund_details is ON DELETE CASCADE; explicit here for clarity)
delete from public.b2c_stripe_refund_details;
delete from public.b2c_refund_fx_conversions;   -- ON DELETE RESTRICT: must precede b2c_refunds
delete from public.b2c_refunds;

-- payment-side dependents
delete from public.b2c_stripe_payment_details;
delete from public.b2c_payment_duplicate_group_members;
delete from public.b2c_payment_duplicate_groups;          -- FK: canonical_payment_id
delete from public.b2c_payment_finance_exception_decisions;
delete from public.b2c_payment_fx_conversions;            -- ON DELETE RESTRICT
delete from public.b2c_payment_local_overrides;

-- review trail (loose refs to payments, but FK-ordered among themselves via flag_id)
delete from public.review_notes             where flag_id in (select id from _wipe_flag_ids);
delete from public.review_flag_resolutions  where flag_id in (select id from _wipe_flag_ids);
delete from public.review_flags             where id      in (select id from _wipe_flag_ids);

delete from public.financial_corrections where target_area in ('b2c_payment', 'b2c_refund');

delete from public.b2c_payments;

-- LAST: the deletes above fired audit triggers that inserted brand-new rows.
delete from public.audit_events where area in ('b2c_payments', 'b2c_refunds');
delete from public.audit_events
 where area in ('review_flags', 'review_flag_resolutions', 'review_notes')
   and record_id in (select id from _wipe_flag_ids);

-- Reset historical-backfill progress so the next run starts genuinely fresh. See Step 3.
update public.integration_sync_runs
   set status = 'cancelled'
 where operation_type = 'historical_backfill'
   and provider in ('stripe', 'tap')
   and status <> 'cancelled';

-- Verify BEFORE committing. Expect all zeros except customers, which must be unchanged.
select 'payments='   || (select count(*) from public.b2c_payments)
    || ' refunds='   || (select count(*) from public.b2c_refunds)
    || ' b2cflags='  || (select count(*) from public.review_flags where source_area in ('b2c_payment','b2c_refund'))
    || ' b2caudit='  || (select count(*) from public.audit_events where area in ('b2c_payments','b2c_refunds'))
    || ' customers=' || (select count(*) from public.customers) as result;

-- Inspect the row above. Then, and only then:
commit;
-- (or `rollback;` if anything looks wrong)
```

**Validation note:** this exact script was executed against a freshly reset **local** database inside
a `begin; … rollback;` block. It completed with no FK violation and returned
`payments=0 refunds=0 b2cflags=0 b2caudit=0 customers=2` — i.e. it wipes what it should and leaves
customers alone. It has **never** been run against remote.

---

## Step 3 — Why `integration_sync_runs` is reset, not deleted

The task framing suggested deleting the `historical_backfill` rows. **Do not delete them.**
`integration_errors.sync_run_id` and `integration_events.sync_run_id` both reference
`integration_sync_runs(id)` with no `ON DELETE` action, so a delete fails with an FK violation as
soon as any error or event row references those runs — and force-clearing those rows would destroy a
reviewable error trail.

Setting `status = 'cancelled'` is the correct reset. In
`src/server/repositories/stripe-sync-repository.ts:82` the resume decision is:

```ts
if (latest?.status === "processing" || latest?.status === "failed" || (latest?.status === "completed" && !input.restartCompleted)) {
```

`'cancelled'` matches no branch, so the code falls through to inserting a brand-new run with a null
`continuation_cursor` and zeroed `records_processed` / `records_failed`. That is a true fresh start,
and it preserves the old rows and every FK reference to them.

Note also why this matters more for Tap than Stripe: the Stripe button posts
`{ restartCompleted: true }` (`src/features/admin/stripe-backfill-control.tsx:23`) so a `completed`
Stripe run can already be restarted from the UI, but the Tap button posts `{}`
(`src/app/api/admin/tap/backfill/route.ts:14` makes the field optional), so **a completed Tap run can
never be restarted from the UI without this reset.** Skipping it would make the Tap re-import a
silent no-op.

Do not use `status = 'pending'` (no branch matches, but it also does not reuse the row, so it just
orphans a misleading row) and do not use `status = 'failed'` (rejected by
`integration_sync_runs_check2`, which requires `failed_at` and `safe_error_summary` to be non-null).

---

## Step 4 — What is deliberately NOT touched

`customers` is **not** touched by this wipe. Customers are not payment records; `b2c_payments.customer_id`
references them, not the other way around, so they survive the payment delete and are reused by the
re-import. Nothing outside the B2C payment/refund domain is touched either: no B2B table, no
`financial_targets`, `reports`, `expenses`, `exchange_rates`, or `products` row is affected.

`product_mappings` needs no mention in the wipe because the merged migration removes the table
outright as part of the category removal — by the time you run Step 2 it no longer exists.

---

## Step 5 — Re-trigger a fresh full historical import (UI)

1. Go to **`/operations/b2c`** and open the **Sources** tab (`/operations/b2c?tab=sources`).
2. On the **Stripe** card, expand **"More actions"**, then click
   **"Start or restart historical Stripe import"**.
3. Let it run to completion. The button reads **"Importing historical Stripe payments…"** while
   working. The client pages automatically, posting `/api/admin/stripe/backfill` repeatedly while the
   server reports `hasMore`.
4. Repeat on the **Tap** card: expand **"More actions"**, click
   **"Start or resume historical Tap import"**, and let it finish.

You must be signed in as an **admin**; the backfill routes return 403 otherwise.

**A network blip mid-run is normal and harmless.** Each batch commits its own cursor checkpoint, so an
interrupted run just stops. Click the button again and it resumes from the last checkpoint rather than
re-downloading. This is expected behaviour and is unrelated to the category removal. Tap in particular
walks backwards in 30-day windows to 2021-06-01, so it takes a while and may need several nudges.

---

## Step 6 — Post-import verification checklist

- [ ] **Total payment count is in the right ballpark.**
      `select count(*) from public.b2c_payments;`
      Expect roughly **~1090**. Exact equality is not expected — real time has passed since the
      original import, so genuinely new transactions will have appeared. A result materially *below*
      ~1090 means the import did not finish; re-click the button.
- [ ] **Per-provider sanity:**
      `select provider, count(*) from public.b2c_payments group by provider order by 1;`
      Both `stripe` and `tap` must be non-zero. A zero Tap count is the signature of the Step 3
      reset having been skipped.
- [ ] **Fingerprints are populated.**
      `select count(*) from public.b2c_payments where duplicate_fingerprint is null;`
      Expect **0**. Then spot-check a row:
      `select id, provider, duplicate_fingerprint from public.b2c_payments limit 5;`
      Values must be non-null and must not contain any category token.
- [ ] **Backfill runs show a clean finish.**
      `select provider, status, records_processed, records_failed, completed_at
         from public.integration_sync_runs
        where operation_type = 'historical_backfill' order by created_at desc limit 6;`
      The newest `stripe` and `tap` rows should be `completed`. Investigate any `records_failed > 0`
      (it downgrades B2C source coverage to "completed with exceptions" in the dashboard).
- [ ] **Manual bank transfer duplicate preview still works.** In the UI, start a manual bank-transfer
      entry with details matching an existing payment and confirm the duplicate-preview warning still
      appears. This exercises the rewritten fingerprint path end to end.
- [ ] **B2C dashboard totals render again** (not "not loaded"), and the review queue has no orphaned
      `unmapped_product` flags.

---

## Open items / things to confirm before running

- **`audit_events` scoping is by convention, not by FK.** There is no referential integrity between
  `audit_events` and payments, so the cleanup relies on `area` matching the trigger's `tg_table_name`.
  It is worth running the two `delete … where area in (…)` statements as `select count(*)` first on
  remote to confirm the row counts look sane for your data before committing.
- **Audit-trail loss is intentional here but is a real trade-off.** This wipe discards the B2C
  payment/refund audit history along with the payments. Confirm with the project owner that this is
  acceptable; if it is not, dump `audit_events where area in ('b2c_payments','b2c_refunds')` to a file
  before Step 2.
- **Audit rows for the deleted review flags are scoped via the temp table.** If you run the statements
  piecemeal rather than as one transaction, `_wipe_flag_ids` will not exist and that last delete will
  fail. Run the block as a whole.
- **Row counts on remote are unknown to this document.** The `~1090` figure came from the project
  owner, not from a query. Capture the real pre-wipe counts in Step 2's verification select so the
  post-import comparison in Step 6 is against a real number.
