# Optional Provider Product Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make valid completed Stripe and Tap payments reportable without a PLAYBOOK product mapping while retaining provider descriptions, duplicate protection, existing classifications, and historical audit evidence.

**Architecture:** Retire mapping as a live policy at every boundary: the shared reportability domain stops treating `unmapped` as a blocker; provider ingestion persists source descriptions without consulting mappings; live dashboard and queue projections omit historical `unmapped_product` flags; the Admin mapping route and drawer action are removed; and one forward migration revokes the remaining database write paths while relaxing only the category check in the audited Finance exception. Historical enum values, functions, mappings, corrections, flags, and exact-by-ID review details remain available for audit compatibility.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, Supabase/PostgreSQL, pgTAP, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-24-optional-provider-product-category-design.md`

## Global Constraints

- Follow `docs/BUSINESS_RULES.md`, `docs/ARCHITECTURE.md`, `docs/CODING_STANDARDS.md`, `docs/SECURITY.md`, `docs/DATABASE_RULES.md`, `docs/TESTING_STRATEGY.md`, `docs/ERROR_HANDLING.md`, `docs/INTEGRATIONS.md`, `docs/PROJECT_STRUCTURE.md`, and `docs/DEVELOPMENT_WORKFLOW.md`.
- Treat `old-project/` as read-only and do not import from it.
- Use TDD for every behavior change: write the focused failing regression, observe the expected RED, make the smallest implementation change, then observe GREEN.
- Never edit an applied migration or delete/rewrite historical mappings, classifications, flags, corrections, or audit rows.
- Keep `category_code = 'unmapped'` as the stable internal duplicate-fingerprint input. Never substitute provider description into the fingerprint or infer a normalized category from free text.
- Do not weaken missing-email, provider-status, USD/FX, provider-ID, duplicate-group, business-date, Admin authorization, or audit-reason rules.
- Keep manual bank-transfer and Finance Tracker category requirements unchanged. This plan changes only Stripe/Tap provider-payment mapping policy.
- Do not apply the new migration to the remote Supabase project. Commit it and give the user the exact filename for manual SQL Editor application after merge.
- Do not commit `supabase/.temp/**`, `supabase/.branches/**`, `.DS_Store`, or `tsconfig.tsbuildinfo`.

---

## Task 1: Retire mapping from the reportability and Work-item domain

**Files:**
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `src/lib/b2c/payment-decision.ts`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/server/repositories/b2c-ledger-repository.ts`
- Modify: `src/server/services/b2c-work-items.ts`
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Modify: `tests/b2c-payment-reportability.test.ts`
- Modify: `tests/b2c-payment-decision.test.ts`
- Modify: `tests/b2c-work-items.test.ts`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`

**Interfaces:**
- Remove `categoryCode` from `B2cPaymentReportabilityInput` and `B2cPaymentDecisionInput`; optional classification must not enter the financial decision boundary. Category remains on payment/effective-value/fingerprint types.
- Remove `"unmapped_product"` from `B2cPaymentExclusionReason`.
- Remove `"unmapped_category"` from `B2cBlockingReason`.
- Remove `"mapping"` from `B2cWorkItem["queue"]` and `"map"` from `B2cWorkItem["nextAction"]`.

- [ ] Add a RED reportability regression proving an otherwise-valid succeeded USD provider payment remains reportable with both `categoryCode: "unmapped"` and an open historical `unmapped_product` flag:

```ts
it("does not block a provider payment on optional category metadata", () => {
  const input = {
    paymentStatus: "succeeded" as const,
    customerEmail: "member@example.com",
    openFlagTypes: new Set(["unmapped_product"]),
    originalCurrency: "USD",
    amountUsd: "120.000000",
  };

  expect(b2cPaymentExclusionReasons(input)).toEqual([]);
  expect(isReportableB2cPayment(input)).toBe(true);
});
```

- [ ] Add or retain table-driven RED cases proving missing email, failed/pending status, missing FX, `possible_duplicate`, duplicate exclusion, and blocking `needs_follow_up` still exclude.
- [ ] Replace the mapping work-item tests with RED assertions that an unmapped provider decision is `reportable` and produces no mapping item; retain the multi-reason test using two still-valid blockers such as missing email plus missing FX.
- [ ] Run the focused RED suite and confirm failures are specifically the old mapping gate/types:

```bash
npx vitest run tests/b2c-payment-reportability.test.ts tests/b2c-payment-decision.test.ts tests/b2c-work-items.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx
```

- [ ] Remove the category/flag gate from `b2cPaymentExclusionReasons` so its core remains:

```ts
if (input.amountUsd === null) reasons.push("needs_fx_review");
if (input.paymentStatus !== "succeeded") reasons.push("not_succeeded");
if (!input.customerEmail && !exceptionApproved && !approvedFinancePayment) reasons.push("missing_customer_email");
if (input.openFlagTypes.has("possible_duplicate")) reasons.push("possible_duplicate");
```

- [ ] Remove the retired reason translation/copy and the mapping `REASON_PLAN`. Remove `categoryCode` from reportability/decision inputs and every call site in the dashboard/ledger projections and focused tests; keep it unchanged on provider persistence, effective-payment, local-correction, Finance-import, and duplicate-fingerprint inputs.
- [ ] Confirm the existing manual-bank-transfer request schema and Finance-import/posting guards still require their explicit category fields; do not edit those boundaries.
- [ ] Remove the drawer's `unmapped_category` reason mapping. Keep the private `map` action union temporarily so Task 4 can remove the drawer contract and mapping UI atomically without a transient type error.
- [ ] Run the focused suite and confirm GREEN.
- [ ] Commit:

```bash
git add src/lib/b2c/payment-reportability.ts src/lib/b2c/payment-decision.ts src/server/repositories/b2c-dashboard-repository.ts src/server/repositories/b2c-ledger-repository.ts src/server/services/b2c-work-items.ts src/features/b2c/b2c-payment-review-drawer.tsx tests/b2c-payment-reportability.test.ts tests/b2c-payment-decision.test.ts tests/b2c-work-items.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx
git commit -m "refactor(b2c): make provider categories optional"
```

---

## Task 2: Stop provider ingestion from reading or creating mappings

**Files:**
- Modify: `src/server/repositories/stripe-sync-repository.ts`
- Create: `tests/b2c-provider-sync-repository.test.ts`
- Modify: `tests/stripe-integration.test.ts`
- Modify: `tests/tap-integration.test.ts`

**Interfaces:**
- `persistCharge()` keeps its public signature and return type.
- Existing payment lookup adds `product_mapping_id`, `category_code`, and `membership_tier` so re-delivery preserves retained classifications.
- Delete private `findProductMapping()` and remove `"unmapped_product"` from `openFlag()`'s accepted flag-type union.

- [ ] Build a focused fake Supabase client in `tests/b2c-provider-sync-repository.test.ts` that records table names, selected columns, writes, and review-flag inserts without network or Docker access.
- [ ] Add RED tests for both `SupabaseStripeSyncRepository` and `SupabaseTapSyncRepository` proving a new charge:
  - never reads `product_mappings`;
  - writes `product_mapping_id: null` and `category_code: "unmapped"`;
  - preserves `source_metadata.description` and `source_metadata.provider_plan_name` when the provider supplied them; and
  - never inserts an `unmapped_product` review flag.
- [ ] Add a RED re-delivery test with an existing mapped row and assert the update keeps the exact mapping/category/tier:

```ts
expect(paymentUpdate).toEqual(expect.objectContaining({
  product_mapping_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  category_code: "membership",
  membership_tier: "annual",
}));
```

- [ ] Keep Stripe/Tap normalization tests proving direct provider description/plan fields are retained and no product/category is guessed. Remove the obsolete `stripeProductMappingSchema` test/import.
- [ ] Run the new and provider-focused tests and confirm RED for the mapping lookup/flag and classification overwrite:

```bash
npx vitest run tests/b2c-provider-sync-repository.test.ts tests/stripe-integration.test.ts tests/tap-integration.test.ts
```

- [ ] Change the existing lookup and classification selection to the preservation rule:

```ts
const { data: existing, error: existingError } = await this.client.from("b2c_payments")
  .select("id,provider_event_id,customer_email,customer_name,customer_phone,product_mapping_id,category_code,membership_tier,source_metadata")
  .eq("source_system", this.provider)
  .eq("provider_transaction_id", input.chargeId)
  .maybeSingle();

const categoryCode = existing?.category_code ?? "unmapped";
// values
product_mapping_id: existing?.product_mapping_id ?? null,
category_code: categoryCode,
membership_tier: existing?.membership_tier ?? input.sourceMetadata.provider_plan_name ?? null,
```

- [ ] Continue computing the duplicate fingerprint with `categoryCode`; remove `findProductMapping()` and only the `if (!mapping) openFlag(...)` branch. Do not alter provider-ID idempotency, customer evidence precedence, FX flags, failed flags, or duplicate SQL ownership.
- [ ] Run the focused suite and confirm GREEN.
- [ ] Commit:

```bash
git add src/server/repositories/stripe-sync-repository.ts tests/b2c-provider-sync-repository.test.ts tests/stripe-integration.test.ts tests/tap-integration.test.ts
git commit -m "refactor(b2c): retain provider descriptions without mapping"
```

---

## Task 3: Remove unmapped policy artifacts from B2C dashboard and Ledger projections

**Files:**
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/server/repositories/b2c-ledger-repository.ts`
- Modify: `src/lib/validation/b2c-workspace-contracts.ts`
- Modify: `src/features/b2c/b2c-workspace.tsx`
- Modify: `src/mocks/b2c.ts`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx`
- Modify: `tests/b2c-tap-statement-unmatched-ledger.test.tsx`
- Modify: `tests/b2c-workspace-ui.test.tsx`

**Interfaces:**
- Remove `"Unmapped product"` from `B2cLedgerRow["issue"]` and the ledger query Zod enum.
- Remove `unmappedProductCount` from `B2cDashboardSnapshot.calculation`.
- Preserve `B2cLedgerRow.category: string`; `"Unmapped"` remains optional internal metadata, not an issue.
- Preserve `sourceDescription: string | null` and render unavailable descriptions as `—`.
- Keep `B2cOpenReviewFlag`'s legacy `"Unmapped product"` type member through this task only, so the existing mapping fragment remains type-correct until Task 4 removes that fragment and narrows the type.

- [ ] Add RED repository/presentation assertions that a valid succeeded unmapped Stripe/Tap row:
  - contributes to reportable totals;
  - has no `Unmapped product` issue or open live review flag;
  - still shows its source description; and
  - shows `—` when the provider supplied no description.
- [ ] Add a RED API/query-contract assertion that `issue=Unmapped%20product` is rejected with 422, while every remaining Issue filter is still accepted.
- [ ] Update the workspace fixture tests to assert `Why totals differ` has no unmapped count/copy and Ledger filter options never contain `Unmapped product`.
- [ ] Run the focused RED suite:

```bash
npx vitest run tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-tap-statement-unmatched-ledger.test.tsx tests/b2c-workspace-ui.test.tsx tests/b2c-workspace-api.test.ts
```

- [ ] Filter retired flags before building any live dashboard grouping, counts, issues, or `openReviewFlags`:

```ts
const liveFlags = [...(paymentFlagsResult.data ?? []), ...(refundFlagsResult.data ?? [])]
  .filter((flag) => flag.flag_type !== "unmapped_product");

for (const flag of liveFlags) {
  flagsByRecord.set(flag.source_record_id, [...(flagsByRecord.get(flag.source_record_id) ?? []), flag]);
}
```

- [ ] Remove the `flagLabel()` unmapped branch, `unmappedProductCount` declaration/increment/return, and `OPEN_FLAG_LABEL_TO_TYPE` mapping. Keep duplicate, follow-up, failed, refund, and FX projections unchanged.
- [ ] Remove the retired Issue enum value and dashboard copy; update all snapshot mocks/fixtures for the smaller calculation contract.
- [ ] Confirm the description column/card still reads `row.sourceDescription ?? "—"`; do not fall back to category or product reference.
- [ ] Run the focused suite and confirm GREEN.
- [ ] Commit:

```bash
git add src/server/repositories/b2c-dashboard-repository.ts src/server/repositories/b2c-ledger-repository.ts src/lib/validation/b2c-workspace-contracts.ts src/features/b2c/b2c-workspace.tsx src/mocks/b2c.ts tests/b2c-stripe-enrichment-dashboard.test.tsx tests/b2c-tap-statement-unmatched-ledger.test.tsx tests/b2c-workspace-ui.test.tsx tests/b2c-workspace-api.test.ts
git commit -m "refactor(b2c): retire unmapped ledger issues"
```

---

## Task 4: Remove the Admin mapping API and drawer action

**Files:**
- Delete: `src/app/api/admin/b2c/products/map/route.ts`
- Modify: `src/lib/validation/financial-contracts.ts`
- Modify: `src/features/b2c/b2c-payment-review-actions.tsx`
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/features/admin/stripe-sync-control.tsx`
- Modify: `tests/b2c-payment-review-drawer.test.tsx`
- Create: `tests/b2c-product-mapping-retirement.test.ts`

**Interfaces:**
- Delete `productMappingSchema`, `stripeProductMappingSchema`, `b2cProductMappingSchema` and their inferred input types.
- Remove `"map"` from both `DrawerPrimaryAction` and `B2cPaymentActionPrimary`, then remove the `ActionSlot` `primary === "map"` path in the same change.
- Remove the temporary legacy `"Unmapped product"` member from `B2cOpenReviewFlag` after the mapping fragment no longer reads it.
- `B2cPaymentLocalValuesFragment` keeps optional category/tier correction fields.
- `B2cPaymentFinanceDecisionFragment` may be used for a missing-email exception without requiring `row.category !== "Unmapped"`.

- [ ] Add RED drawer tests proving an Admin viewing an unmapped provider payment sees the provider description and local correction/eligible exception controls, but no `Create reusable product mapping`, mapping form, `Map this`, or `/api/admin/b2c/products/map` fetch.
- [ ] Add RED Finance-exception UI tests proving `Unmapped` is not listed as a source gap and does not disable an otherwise-eligible missing-email exception; keep provider-ID and duplicate confirmations plus reason mandatory.
- [ ] Add a RED user-visible regression proving the shared drawer renders no mapping control or mapping fetch for an unmapped provider record; route deletion is verified by the exact route-file deletion in the reviewed diff and the final ownership scan.

- [ ] Run the focused RED suite:

```bash
npx vitest run tests/b2c-payment-review-drawer.test.tsx tests/b2c-product-mapping-retirement.test.ts
```

- [ ] Delete the route and request schemas/types. Remove mapping-only component state, `mapProduct()`, availability checks, mapping block, and mapping primary-action rendering, including the private `map` action types and `ActionSlot` branch.
- [ ] Change Finance-exception eligibility to depend on a missing source email and every retained safety fact, not category:

```ts
const canUseFinanceException = !requiresFxReview
  && row.paymentStatus === "Completed"
  && Boolean(row.providerReference)
  && !row.hasFinanceException;

const financeExceptionSourceGaps = row.openReviewFlags
  .filter((flag) => flag.type === "Missing customer email")
  .map(() => "customer email");
```

- [ ] Preserve the actual existing provider-ID, no-known-duplicate, USD/date, reason, role, and server-side checks. Update copy so category/tier are described as optional local metadata rather than Finance prerequisites.
- [ ] Remove obsolete mapping copy from the Admin sync control without changing sync ownership or provider read-only behavior.
- [ ] Run the focused suite and confirm GREEN.
- [ ] Commit:

```bash
git add -A src/app/api/admin/b2c/products/map/route.ts src/lib/validation/financial-contracts.ts src/features/b2c/b2c-payment-review-actions.tsx src/features/b2c/b2c-payment-review-drawer.tsx src/server/repositories/b2c-dashboard-repository.ts src/features/admin/stripe-sync-control.tsx tests/b2c-payment-review-drawer.test.tsx tests/b2c-product-mapping-retirement.test.ts
git commit -m "refactor(b2c): remove provider mapping workflow"
```

---

## Task 5: Exclude historical unmapped flags from the live Review Queue

**Files:**
- Modify: `src/server/services/review-queue.ts`
- Modify: `src/server/repositories/review-queue-repository.ts`
- Modify: `src/lib/validation/review-queue-contracts.ts`
- Modify: `src/features/review-queue/review-queue-page.tsx`
- Modify: `tests/review-queue-contracts.test.ts`
- Modify: `tests/review-queue-api.test.ts`

**Interfaces:**
- Keep `ReviewQueueFlagType` including `"unmapped_product"` so exact historical details remain type-safe.
- Add `ReviewQueueLiveFlagType = Exclude<ReviewQueueFlagType, "unmapped_product">` and use it for `ReviewQueueFilters.flagType`.
- `listFlags()` omits historical unmapped flags; `getFlagDetail(id)` remains unchanged.

- [ ] Add RED contract tests proving `flagType=unmapped_product` is rejected and the filter option is absent.
- [ ] Add a RED service/API test whose repository returns one historical unmapped flag and one current duplicate; assert the live list/metrics include only the duplicate.
- [ ] Add a regression proving exact detail for the historical unmapped flag is still converted to a read-only review detail, with no mapping mutation action.
- [ ] Run the focused RED suite:

```bash
npx vitest run tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts
```

- [ ] Narrow live filter types and add defense-in-depth service filtering:

```ts
export type ReviewQueueLiveFlagType = Exclude<ReviewQueueFlagType, "unmapped_product">;

const liveFlags = (await repository.listFlags())
  .filter((flag) => flag.flagType !== "unmapped_product");
const items = filterReviewQueueItems(liveFlags.map(toReviewQueueItem), filters);
```

- [ ] Add `.neq("flag_type", "unmapped_product")` only to `listFlags()` and leave `getFlagDetail()`'s exact `.eq("id", flagId)` path unchanged.
- [ ] Remove the value from `reviewQueueListQuerySchema` and the page filter options; retain the historical label mapping so exact detail renders intelligibly.
- [ ] Run the focused suite and confirm GREEN.
- [ ] Commit:

```bash
git add src/server/services/review-queue.ts src/server/repositories/review-queue-repository.ts src/lib/validation/review-queue-contracts.ts src/features/review-queue/review-queue-page.tsx tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts
git commit -m "refactor(review): hide retired product mapping flags"
```

---

## Task 6: Enforce mapping retirement and optional-category exceptions in PostgreSQL

**Files:**
- Create: `supabase/migrations/20260824150000_retire_b2c_product_mapping_requirement.sql`
- Modify: `supabase/tests/database_foundation.test.sql`

**Interfaces:**
- Revoke authenticated execution from the two retained mapping functions.
- Preserve authenticated read access to `product_mappings`, but revoke `INSERT`/`UPDATE` and drop only that table's `admin_insert`/`admin_update` policies.
- Preserve the signature, Admin authorization, audit behavior, grants, and all non-category guards of `include_b2c_payment_with_finance_exception(uuid,text,boolean,boolean)`.

- [ ] Append 12 pgTAP assertions and change `select plan(138)` to `select plan(150)`. Cover:
  1. neither mapping function is executable by `authenticated`;
  2. `authenticated` has neither insert nor update table privilege;
  3. both product-mapping write policies are absent;
  4. retained mappings remain readable;
  5. an authenticated Admin cannot call the Stripe mapping function;
  6. an authenticated Admin cannot call the Tap mapping function;
  7. an authenticated Admin cannot insert a mapping directly;
  8. an authenticated Admin cannot update a mapping directly;
  9. an otherwise-eligible unmapped USD provider payment with missing email can receive the Finance exception;
  10. its append-only decision and financial-correction audit facts are retained;
  11. missing provider/duplicate confirmations still fail; and
  12. a failed payment still fails.
- [ ] Run the database test against the current schema before adding the migration and confirm RED on the new privilege/category assertions:

```bash
npm run supabase:test
```

- [ ] Create the forward migration with these exact privilege/policy changes:

```sql
revoke execute on function public.apply_stripe_product_mapping(text, text, text, text, text, text)
  from authenticated;
revoke execute on function public.apply_b2c_product_mapping(text, text, text, text, text, text, text)
  from authenticated;

revoke insert, update on table public.product_mappings from authenticated;
drop policy if exists admin_insert on public.product_mappings;
drop policy if exists admin_update on public.product_mappings;
```

- [ ] Copy the latest complete `include_b2c_payment_with_finance_exception` body from `20260813190000_b2c_manual_fx_conversions.sql` into the forward migration and remove only this retired check:

```sql
if effective_category_code is null or lower(trim(effective_category_code)) = 'unmapped' then
  raise exception 'Save a verified local PLAYBOOK category before using a Finance exception';
end if;
```

- [ ] Keep `effective_category_code` and the correction JSON field so retained classification remains visible in audit history. Keep the function `security definer set search_path = public`, and finish with:

```sql
revoke all on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) from public;
grant execute on function public.include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean) to authenticated;
```

- [ ] Reset the local database and run pgTAP GREEN:

```bash
npm run supabase:reset
npm run supabase:test
```

- [ ] Verify migration ordering and ensure the new filename occurs exactly once:

```bash
rg -n "20260824150000_retire_b2c_product_mapping_requirement|apply_stripe_product_mapping|include_b2c_payment_with_finance_exception" supabase/migrations supabase/tests/database_foundation.test.sql
```

- [ ] Commit:

```bash
git add supabase/migrations/20260824150000_retire_b2c_product_mapping_requirement.sql supabase/tests/database_foundation.test.sql
git commit -m "fix(b2c): close retired product mapping writes"
```

---

## Task 7: Align documentation, audit the boundary, and complete verification

**Files:**
- Modify: `docs/BUSINESS_RULES.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATABASE_RULES.md`
- Modify: `docs/DATABASE_SCHEMA.md`
- Modify: `docs/INTEGRATIONS.md`
- Modify: `docs/STRIPE_SETUP.md`
- Modify: `docs/PLAYBOOK_REQUIREMENTS_REFERENCE.md`
- Modify: `docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md`
- Modify: `docs/superpowers/plans/2026-08-20-b2c-audit-remediation.md`

- [ ] Update the current business/architecture/database/integration/setup docs to state:
  - provider description is source evidence and the visible product label;
  - provider category/tier are optional local metadata;
  - `unmapped` remains an internal fingerprint value but is not a reportability gate;
  - mapping tables/functions/history are retained read-only;
  - mapping is absent from the B2C Work queue, Ledger issues, generic Review Queue, and shared drawer;
  - Finance exception no longer requires category but retains every other guard; and
  - manual bank-transfer and Finance Tracker category rules are unchanged.
- [ ] Preserve `PLAYBOOK_REQUIREMENTS_REFERENCE.md` as a historical source by appending a dated supersession note to its mapping/review sections instead of silently rewriting the original requirement.
- [ ] Append dated amendments to both completed B2C plans naming the approved spec and forward migration; do not alter their historical task checklists or evidence.
- [ ] Review the Task 4 user-visible mapping-retirement regression and retain it as the behavioral boundary test. Verify route/RPC ownership with the final command-line scans rather than a brittle source-text assertion.

- [ ] Run focused cross-boundary tests:

```bash
npx vitest run tests/b2c-payment-reportability.test.ts tests/b2c-payment-decision.test.ts tests/b2c-work-items.test.ts tests/b2c-provider-sync-repository.test.ts tests/b2c-payment-review-drawer.test.tsx tests/b2c-workspace-ui.test.tsx tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts tests/b2c-product-mapping-retirement.test.ts
```

- [ ] Run the clean full verification matrix:

```bash
npm run supabase:reset
npm run supabase:test
npm test
npx tsc --noEmit
npm run lint
git diff --check
```

- [ ] Run final ownership scans and inspect every remaining match:

```bash
rg -n "products/map|Create reusable product mapping|Map this" src tests
rg -n "unmapped_product|unmapped_category|unmappedProductCount" src tests
rg -n "apply_(stripe|b2c)_product_mapping" src tests
rg -n "product_mappings" src
```

Expected results: no live mapping route/action/RPC caller; no unmapped reportability reason/count; `unmapped_product` remains only where needed for generated database typing, historical exact-detail typing/labeling, and explicit live-list filtering; no product-mapping write owner remains in `src/`.

- [ ] Confirm `git status --short` contains no generated/temp/Finder artifacts staged and no changes under `old-project/`.
- [ ] Commit the docs and final structural test:

```bash
git add docs/BUSINESS_RULES.md docs/ARCHITECTURE.md docs/DATABASE_RULES.md docs/DATABASE_SCHEMA.md docs/INTEGRATIONS.md docs/STRIPE_SETUP.md docs/PLAYBOOK_REQUIREMENTS_REFERENCE.md docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md docs/superpowers/plans/2026-08-20-b2c-audit-remediation.md tests/b2c-product-mapping-retirement.test.ts
git commit -m "docs(b2c): document optional provider categories"
```

- [ ] Record the final commit range and verification results. Tell the user that the only manual database action is to run `supabase/migrations/20260824150000_retire_b2c_product_mapping_requirement.sql` in Supabase SQL Editor after the merged code is deployed, then confirm the migration succeeded before relying on the new behavior.

---

## 2026-08-24 remediation amendment — preserved retired unmapped-product flag history

This amendment preserves the historical Task 7 checklist and evidence above.
The final manual database action after integration and deployment is to run both
forward migrations in Supabase SQL Editor, in this order:

1. `supabase/migrations/20260824150000_retire_b2c_product_mapping_requirement.sql`
2. `supabase/migrations/20260824151000_preserve_retired_unmapped_product_flag_history.sql`

Confirm both migrations succeed before relying on the optional-category
behavior. Never run `supabase db push` for this work.
