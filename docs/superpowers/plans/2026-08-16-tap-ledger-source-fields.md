# Tap Ledger Source Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the retained Tap provider description and original customer currency in the B2C source ledger without re-importing or changing Tap.

**Architecture:** Tap normalisation already stores `description` in `b2c_payments.source_metadata` and the original customer currency in `original_currency`. The B2C dashboard repository will expose one provider-neutral description field and the existing source currency field. The ledger table will render both fields, retaining Stripe’s richer evidence description when available.

**Tech Stack:** Next.js 15, React 19, TypeScript, Supabase repository projections, Vitest, Testing Library.

## Global Constraints

- PLAYBOOK only reads from Stripe, Tap, and HubSpot; this task performs no external provider write.
- Preserve original provider amount and currency; do not infer a USD value for a foreign-currency payment.
- No migration or re-import is required because the relevant Tap metadata is already stored locally.
- Keep B2C financial totals and reportability behavior unchanged.

---

### Task 1: Expose a provider-neutral description from the dashboard repository

**Files:**
- Modify: `src/server/repositories/b2c-dashboard-repository.ts:9-58,235-247,473-568`
- Test: `tests/b2c-tap-ledger-source-fields.test.ts`

**Interfaces:**
- Produces: `resolveLedgerSourceDescription(sourceMetadata: unknown, stripeDescription?: string | null): string | null`
- Produces: `B2cLedgerRow.sourceDescription: string | null`
- Consumes: retained Tap `source_metadata.description` and existing Stripe evidence description.

- [x] **Step 1: Write the failing test**

```ts
import { resolveLedgerSourceDescription } from "@/server/repositories/b2c-dashboard-repository";

it("uses the retained Tap source description when Stripe evidence is absent", () => {
  expect(resolveLedgerSourceDescription({ description: "Sale - Fatima Abbas" }, null))
    .toBe("Sale - Fatima Abbas");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/b2c-tap-ledger-source-fields.test.ts`

Expected: FAIL because `resolveLedgerSourceDescription` is not exported yet.

- [x] **Step 3: Write minimal implementation**

```ts
export function resolveLedgerSourceDescription(
  sourceMetadata: unknown,
  stripeDescription: string | null | undefined,
): string | null {
  return stripeDescription?.trim() || sourceMetadataText(sourceMetadata, "description");
}
```

Add `sourceDescription` to the `B2cLedgerRow` type. Populate it for payments using retained source metadata and, for Stripe, the richer Stripe evidence. Set it to `null` for refunds because the current dashboard query does not retain a refund description.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/b2c-tap-ledger-source-fields.test.ts`

Expected: PASS.

### Task 2: Render source currency and source description in the B2C ledger

**Files:**
- Modify: `src/features/b2c/b2c-operations.tsx:114-170`
- Modify: `tests/b2c-stripe-enrichment-dashboard.test.tsx:78-122`

**Interfaces:**
- Consumes: `B2cLedgerRow.sourceOriginalCurrency` and `B2cLedgerRow.sourceDescription`.
- Produces: ledger headers `Reporting amount`, `Source currency`, and `Description` with matching values in each row.

- [x] **Step 1: Write the failing UI test**

```tsx
expect(screen.getByRole("columnheader", { name: "Source currency" })).toBeInTheDocument();
expect(screen.getByText("USD")).toBeInTheDocument();
expect(screen.getByText("Founding Membership renewal")).toBeInTheDocument();
```

Use the existing ledger snapshot fixture and add `sourceDescription: "Founding Membership renewal"` plus `sourceOriginalCurrency: "USD"`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: FAIL because the table has no `Source currency` column and still reads only `stripeEvidence.description`.

- [x] **Step 3: Write minimal implementation**

```tsx
<LedgerSortHeader label="Reporting amount" sortKey="amount" sort={sort} onSort={onSort} />
<TableHeader>Source currency</TableHeader>
<TableHeader>Description</TableHeader>
...
<TableCell>{row.sourceOriginalCurrency ?? "—"}</TableCell>
<TableCell>{row.sourceDescription ?? "—"}</TableCell>
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: PASS.

### Task 3: Document and verify the no-reimport behavior

**Files:**
- Modify: `docs/INTEGRATIONS.md`

- [x] **Step 1: Document retained Tap ledger fields**

Add a short B2C/Tap note that the ledger displays Tap API customer currency and retained charge description from `source_metadata`, while the Tap BHD statement remains separate settlement evidence. State that displaying these existing fields requires a browser refresh, not a Tap backfill.

- [x] **Step 2: Run focused verification**

Run: `npm test -- tests/b2c-tap-ledger-source-fields.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx`

Expected: PASS.

- [x] **Step 3: Run repository verification**

Run: `npm run typecheck && npm run lint`

Expected: both commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/server/repositories/b2c-dashboard-repository.ts src/features/b2c/b2c-operations.tsx tests/b2c-tap-ledger-source-fields.test.ts tests/b2c-stripe-enrichment-dashboard.test.tsx docs/INTEGRATIONS.md docs/superpowers/plans/2026-08-16-tap-ledger-source-fields.md
git commit -m "fix(b2c): show Tap source details in ledger"
```
