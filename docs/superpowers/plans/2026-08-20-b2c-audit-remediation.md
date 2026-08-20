# B2C Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every defect found by the post-completion audit of the B2C single-control-flow work, and make the class of bug that caused the worst of them structurally impossible to ship again.

**Architecture:** The root cause of the critical defect was a *duplicated formula across the TypeScript/SQL boundary that no test compared*. So this plan front-loads two things: getting pgTAP actually running (it has never once executed), and replacing "verify by reading" with a shared golden-corpus parity test. Only then do we fix the remaining functional defects, each verified by a test that crosses the boundary it concerns.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Supabase PostgreSQL/RLS/pgTAP, Tailwind CSS, Vitest, Testing Library.

**Spec:** `docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md` (the original plan; its "Progress & amendments" section records the audit findings this plan remediates).

## Global Constraints

- Source payments, refunds, workbook rows, statements, and imported evidence remain immutable and traceable.
- Missing financial values are unavailable, never zero. Unknown FX never becomes an inferred USD value.
- Every manual financial action records the authenticated actor, timestamp, reason, before values, and after values.
- Every browser write uses a request-scoped authenticated Supabase client; the database remains the authorization and audit boundary.
- A live action must render in exactly one place. Reuse one service, validation contract, and API route per action.
- The user applies all Supabase migrations manually. Never run migrations against the live project; never write to live data.
- Do not modify `old-project/`. Do not stage `tsconfig.tsbuildinfo`, `supabase/.temp/`, `.DS_Store`, or credentials.
- **No formula that exists in both TypeScript and SQL may be considered correct without a test that computes both and asserts equality.** This is the constraint whose absence caused the critical defect.

---

## Defect Register

Every task below closes one or more of these. IDs are referenced by task.

| ID | Severity | Defect | Status |
|---|---|---|---|
| D1 | Critical | Identity separator: TS used a raw NUL, SQL used a space | **Fixed** in `399e694` (pre-plan) |
| D2 | Critical | Identity canonicalization: TS uses NFKD+mark-strip, SQL uses `unaccent()` — different algorithms | Open — found during this plan's investigation, **not** in the external audit |
| D3 | High | Exact cross-tab `B2C`+`B2C Cons` pairs classify as `ambiguous` and can never be posted | Open |
| D4 | High | Import-version decisions have no reachable UI; candidates never become work items | Open |
| D5 | High | First-import auto-link never records a decision → permanent phantom candidates in readiness | Open |
| D6 | Medium | Provider-evidence mismatches computed then discarded; never persisted or surfaced | Open |
| D7 | Medium | Generic `possible_duplicate` payments route to the Finance workbook exact-pair component | Open |
| D8 | Medium | Ledger filters apply only to already-loaded rows, not server-side | Open |
| D9 | Medium | Manual-transfer timestamp: RPC accepts a timestamp with no explicit offset | Open |
| D10 | Medium | `date-authority` staging-row date fix has no live UI caller | Open |

---

## File Structure

**New files**
- `supabase/migrations/20260820100000_b2c_shared_identity_canonicalization.sql` — one canonical-text SQL function, replacing three inline copies (D2)
- `supabase/migrations/20260820103000_b2c_exact_pair_and_candidate_decisions.sql` — exact-pair confirm + first-import decision rows (D3, D5)
- `supabase/migrations/20260820110000_b2c_provider_evidence_mismatches.sql` — persist mismatches (D6)
- `supabase/migrations/20260820113000_b2c_manual_transfer_offset_guard.sql` — require explicit UTC offset (D9)
- `tests/b2c-identity-parity-corpus.ts` — the shared golden corpus, imported by both the Vitest parity test and the pgTAP fixture generator (D2)
- `tests/b2c-finance-identity-parity.test.ts` — Vitest half of the parity check (D2)
- `src/features/b2c/b2c-import-version-decision.tsx` — the drawer fragment that resolves a candidate (D4)
- `src/features/b2c/b2c-staging-date-authority.tsx` — the drawer fragment that resolves a staging-row date conflict (D10)

**Modified**
- `src/lib/b2c/finance-source-identity.ts` — canonicalization aligned to the shared SQL rule (D2)
- `src/server/services/b2c-finance-import-versioning.ts` — carry `sourceTab`, classify approved exact pairs (D3)
- `src/server/repositories/b2c-finance-reconciliation-repository.ts` — supply `sourceTab` to the diff (D3)
- `src/server/services/payment-tracker-upload.ts` — supply `sourceTab` to the diff (D3)
- `src/server/repositories/b2c-workspace-repository.ts` — candidates and evidence mismatches become work items (D4, D6)
- `src/server/services/b2c-work-items.ts` — work-item plans for the new kinds (D4, D6)
- `src/features/b2c/b2c-payment-review-drawer.tsx` — route to the new fragments; split Finance vs generic duplicates (D4, D7, D10)
- `src/features/b2c/b2c-workspace.tsx` — send filters to the server (D8)
- `src/server/services/b2c-provider-evidence-reconciliation.ts` — persist mismatches (D6)
- `src/features/b2c/b2c-manual-bank-transfer.tsx` — explicit offset in the submitted timestamp (D9)
- `supabase/tests/database_foundation.test.sql` — must actually pass (Task 1)

---

### Task 1: Make pgTAP actually run

The 88 pgTAP assertions across Tasks 1–6 were written blind and have **never executed once**. They are the only layer that can catch a TS/SQL divergence. Expect the first run to fail — that is the point of this task, and fixing those failures *is* the work.

**Files:**
- Modify: `supabase/tests/database_foundation.test.sql` (as failures dictate)
- Modify: `docs/TESTING_STRATEGY.md`

**Interfaces:**
- Produces: a green `npm run supabase:test`, which every later task in this plan depends on for verification.

- [ ] **Step 1: Start the local stack**

Docker is installed but its daemon is stopped. Start Docker Desktop, then:

```bash
docker info --format '{{.ServerVersion}}'
```

Expected: a version string, not "Cannot connect to the Docker daemon".

- [ ] **Step 2: Bring up Supabase and apply every migration**

```bash
npm run supabase:start && npm run supabase:reset
```

Expected: all migrations in `supabase/migrations/` apply cleanly, in filename order. If a migration fails here, that is a real defect in that migration — fix it before continuing, and note it in the plan's status section.

- [ ] **Step 3: Run pgTAP for the first time ever**

```bash
npm run supabase:test
```

Expected: **failures.** Record the full output before changing anything. Typical causes to expect: fixture rows that violate constraints added by a later migration, `plan(N)` counts that no longer match the number of assertions, and assertions written against a function signature that changed.

- [ ] **Step 4: Fix each failure, smallest first**

For each failing assertion decide, and write the reason in a comment above it:
- the **assertion** is wrong (written blind against an imagined schema) → fix the assertion;
- the **migration** is wrong (a real defect) → fix the migration and add it to the Defect Register at the top of this plan.

Do not delete an assertion to make the suite green. If an assertion cannot be made to pass, that is a finding, not a cleanup.

- [ ] **Step 5: Verify green**

```bash
npm run supabase:test
```

Expected: PASS, with the `plan(N)` count matching the actual number of assertions.

- [ ] **Step 6: Document the workflow**

Add to `docs/TESTING_STRATEGY.md`, in the pgTAP section:

```markdown
pgTAP is the only layer that verifies a formula duplicated across the
TypeScript/SQL boundary. It requires Docker running plus `npm run
supabase:start`; `npm run supabase:reset` applies every migration and `npm
run supabase:test` runs the assertions. Run it before trusting any change to
B2C Finance identity, lineage, posting, or duplicate logic — the Vitest suite
compares TypeScript to TypeScript only and cannot see a cross-language
divergence.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/tests/database_foundation.test.sql docs/TESTING_STRATEGY.md
git commit -m "test(b2c): make the pgTAP suite actually run and pass"
```

---

### Task 2: One canonicalization rule, proven by a shared corpus (D2)

TypeScript canonicalizes identity text with `NFKD` + combining-mark removal; the three SQL sites use `lower(unaccent(...))`. These are different algorithms. They agree on plain ASCII and on simple accents (`José` → `jose` both ways) but diverge on non-decomposable letters (`Ł` → `ł` in TS, `l` via unaccent) and on scripts unaccent does not cover, including Arabic diacritics. Every such name gets two different identities — the same failure mode as D1, still live.

The durable fix is not "make the two implementations look alike" (that inspection already failed twice) but "make divergence impossible to ship undetected": one SQL function, one TS mirror, and a golden corpus run through both.

**Files:**
- Create: `supabase/migrations/20260820100000_b2c_shared_identity_canonicalization.sql`
- Create: `tests/b2c-identity-parity-corpus.ts`
- Create: `tests/b2c-finance-identity-parity.test.ts`
- Modify: `src/lib/b2c/finance-source-identity.ts`
- Modify: `supabase/tests/database_foundation.test.sql`

**Interfaces:**
- Consumes: a green pgTAP suite from Task 1.
- Produces: `public.b2c_canonical_identity_text(text) returns text` (SQL) and `canonicalIdentityText(value: string): string` (TS), guaranteed equal over the corpus. Later tasks must not reimplement either.

- [ ] **Step 1: Write the shared corpus**

Create `tests/b2c-identity-parity-corpus.ts`. Every entry is a real-shaped name that stresses a different divergence:

```ts
/**
 * Names run through BOTH the TypeScript and SQL canonicalization, which must
 * produce byte-identical output. Add a case here whenever a new class of
 * character appears in real customer data -- this corpus is the only thing
 * standing between a canonicalization change and a silent duplicate payment.
 */
export const identityParityCorpus = [
  "Maya Al Khalifa",
  "hoor alshubbar",
  "  Reham   Garash  ",
  "MAYA AL KHALIFA",
  "José García",
  "Müller",
  "Ḥasan Ibn Sīnā",
  "Łukasz Nowak",
  "Ærik Ø",
  "Ahmad Al-Sayed",
  "محمّد عبدالله",
  "O'Brien",
  "Jean-Luc Picard",
] as const;
```

- [ ] **Step 2: Write the failing Vitest parity test**

Create `tests/b2c-finance-identity-parity.test.ts`. It asserts TS canonicalization matches a fixture of SQL output that Step 5 generates:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalIdentityText } from "@/lib/b2c/finance-source-identity";
import { identityParityCorpus } from "./b2c-identity-parity-corpus";

/**
 * `sql-canonical-identity.json` is generated FROM the database by
 * `npm run supabase:test` (see the pgTAP fixture in
 * supabase/tests/database_foundation.test.sql). Regenerate it whenever the
 * corpus or the SQL function changes -- never hand-edit it.
 */
const sqlOutput = JSON.parse(
  readFileSync("tests/fixtures/sql-canonical-identity.json", "utf8"),
) as Record<string, string>;

describe("identity canonicalization is identical in TypeScript and SQL", () => {
  it("covers every corpus entry", () => {
    for (const name of identityParityCorpus) {
      expect(Object.keys(sqlOutput)).toContain(name);
    }
  });

  for (const name of identityParityCorpus) {
    it(`agrees for ${JSON.stringify(name)}`, () => {
      expect(canonicalIdentityText(name)).toBe(sqlOutput[name]);
    });
  }
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `npx vitest run tests/b2c-finance-identity-parity.test.ts`

Expected: FAIL — `canonicalIdentityText` is not exported yet and the fixture does not exist.

- [ ] **Step 4: Write the shared SQL function**

Create `supabase/migrations/20260820100000_b2c_shared_identity_canonicalization.sql`. Use `normalize(..., NFKD)` (PostgreSQL 13+) plus an explicit combining-mark range, mirroring the TypeScript exactly, and **stop using `unaccent()`** for identity text:

```sql
-- The one canonicalization rule for B2C Finance identity text. It exists
-- because three inline copies previously disagreed with the TypeScript
-- implementation (unaccent() vs NFKD + combining-mark removal), silently
-- giving the same real payment two identities. Every SQL site that builds a
-- `source_identity` MUST call this function -- never inline the rule again.
--
-- Mirrors src/lib/b2c/finance-source-identity.ts::canonicalIdentityText.
-- tests/b2c-finance-identity-parity.test.ts asserts the two agree over a
-- shared corpus; changing one without the other will fail that test.
create or replace function public.b2c_canonical_identity_text(value text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(
    regexp_replace(
      btrim(
        regexp_replace(
          -- NFKD splits a precomposed letter into base + combining marks,
          -- then the class below removes only those marks. This is exactly
          -- what String.prototype.normalize("NFKD") + /\p{M}/u does in JS.
          regexp_replace(normalize(coalesce(value, ''), NFKD), '[̀-ͯ҃-҉֑-ֽً-ٰٟۖ-ۜัิ-ฺ᪰-᫿᷀-᷿⃐-⃰︠-︯]', '', 'g'),
          '\s+', ' ', 'g'
        )
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

revoke all on function public.b2c_canonical_identity_text(text) from public;
grant execute on function public.b2c_canonical_identity_text(text) to authenticated;
```

Then replace the three inline copies to call it. In `20260818100000` the trigger becomes:

```sql
  canonical_name := public.b2c_canonical_identity_text(new.customer_name);
```

Apply the same substitution in the backfill loop (`20260818103000`) and the manual-transfer RPC (`20260818113000`). **Do not edit those already-applied migration files** — add the `create or replace function` bodies to this new migration so the change ships forward.

- [ ] **Step 5: Emit the SQL fixture from pgTAP**

Add to `supabase/tests/database_foundation.test.sql` (and bump `plan(N)` by 1):

```sql
-- Writes the canonical form of every parity-corpus name to a fixture the
-- Vitest suite compares against. This is the only mechanism that catches a
-- TypeScript/SQL canonicalization divergence.
select lives_ok(
  $$ copy (
       select json_object_agg(name, public.b2c_canonical_identity_text(name))
       from (values
         ('Maya Al Khalifa'), ('hoor alshubbar'), ('  Reham   Garash  '),
         ('MAYA AL KHALIFA'), ('José García'), ('Müller'),
         ('Ḥasan Ibn Sīnā'), ('Łukasz Nowak'), ('Ærik Ø'),
         ('Ahmad Al-Sayed'), ('محمّد عبدالله'), ('O''Brien'),
         ('Jean-Luc Picard')
       ) as corpus(name)
     ) to '/tmp/sql-canonical-identity.json' $$,
  'canonical identity text is emitted for the TypeScript parity corpus'
);
```

Then copy it into the repo fixture:

```bash
mkdir -p tests/fixtures
docker compose -f supabase/docker-compose.yml cp db:/tmp/sql-canonical-identity.json tests/fixtures/sql-canonical-identity.json 2>/dev/null \
  || supabase db execute --local --file /dev/stdin <<'SQL' > tests/fixtures/sql-canonical-identity.json
select json_object_agg(name, public.b2c_canonical_identity_text(name))
from (values
  ('Maya Al Khalifa'), ('hoor alshubbar'), ('  Reham   Garash  '),
  ('MAYA AL KHALIFA'), ('José García'), ('Müller'),
  ('Ḥasan Ibn Sīnā'), ('Łukasz Nowak'), ('Ærik Ø'),
  ('Ahmad Al-Sayed'), ('محمّد عبدالله'), ('O''Brien'),
  ('Jean-Luc Picard')
) as corpus(name);
SQL
```

If neither form works in this environment, generate the fixture with a one-off `psql` against the local stack — the mechanism matters less than the fixture being **produced by the database, never hand-written**.

- [ ] **Step 6: Export the TS canonicalizer and align it**

In `src/lib/b2c/finance-source-identity.ts`, export the existing function so the parity test can reach it, and add the cross-reference comment:

```ts
/**
 * Mirrors public.b2c_canonical_identity_text(text). The two are asserted
 * byte-identical over a shared corpus by
 * tests/b2c-finance-identity-parity.test.ts -- change both together or that
 * test fails.
 */
export function canonicalIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}
```

- [ ] **Step 7: Run both halves**

```bash
npm run supabase:test && npx vitest run tests/b2c-finance-identity-parity.test.ts
```

Expected: both PASS. If a corpus entry disagrees, the SQL combining-mark class in Step 4 is missing a range — widen it and regenerate the fixture. Do **not** delete the failing corpus entry.

- [ ] **Step 8: Prove the guard works**

Temporarily change the TS `.toLocaleLowerCase("en-US")` to `.toUpperCase()`, re-run the parity test, confirm it FAILS, then revert. A parity test that cannot fail is worthless.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260820100000_b2c_shared_identity_canonicalization.sql \
  src/lib/b2c/finance-source-identity.ts tests/b2c-identity-parity-corpus.ts \
  tests/b2c-finance-identity-parity.test.ts tests/fixtures/sql-canonical-identity.json \
  supabase/tests/database_foundation.test.sql
git commit -m "fix(b2c): one identity canonicalization rule, proven across TS and SQL"
```

---

### Task 3: Approved cross-tab exact pairs become postable (D3)

`previewFinanceImportVersion` never receives `sourceTab`, so it cannot tell the plan-approved `B2C` + `B2C Cons` pair (one real payment recorded on two sheets) from a genuine repeat. Both become `ambiguous`; the database then refuses `confirm_new` for ambiguous candidates and requires an existing lineage for `link_revision`, so a first-import exact pair is permanently unpostable. Current tests encode this broken behavior as expected.

**Files:**
- Modify: `src/server/services/b2c-finance-import-versioning.ts`
- Modify: `src/server/repositories/b2c-finance-reconciliation-repository.ts`
- Modify: `src/server/services/payment-tracker-upload.ts`
- Modify: `tests/b2c-finance-source-identity.test.ts`
- Modify: `supabase/tests/database_foundation.test.sql`

**Interfaces:**
- Consumes: `canonicalIdentityText` from Task 2.
- Produces: `FinanceImportVersionReplacementRow` and `FinanceImportVersionPreviousRow` both gain `sourceTab: "B2C" | "B2C Cons"`. `FinanceImportDiff.newCandidates` may now contain a candidate whose `financeRowIds` has two entries (the approved pair); every other candidate kind keeps exactly one.

- [ ] **Step 1: Write the failing test**

Add to `tests/b2c-finance-source-identity.test.ts`:

```ts
it("treats one B2C row and one B2C Cons row with the same identity as one approved exact pair, not ambiguous", () => {
  const identity = createFinanceSourceIdentity({
    normalizedCustomerName: "reham garash",
    occurredOn: "2026-08-01",
    amountUsd: "475",
    normalizedPaymentMethod: "stripe",
  });
  const b2cRow = { financeRowId: "10000000-0000-4000-8000-000000000030", sourceIdentity: identity, sourceTab: "B2C" as const };
  const consRow = { financeRowId: "10000000-0000-4000-8000-000000000031", sourceIdentity: identity, sourceTab: "B2C Cons" as const };

  const diff = previewFinanceImportVersion({ previous: [], replacement: [b2cRow, consRow] });

  expect(diff.ambiguousCandidates).toHaveLength(0);
  expect(diff.newCandidates).toHaveLength(1);
  expect(diff.newCandidates[0].financeRowIds).toEqual([b2cRow.financeRowId, consRow.financeRowId]);
});

it("still holds two rows from the SAME tab as ambiguous", () => {
  const identity = createFinanceSourceIdentity({
    normalizedCustomerName: "sara ahmed",
    occurredOn: "2026-08-05",
    amountUsd: "50",
    normalizedPaymentMethod: "ios",
  });
  const first = { financeRowId: "10000000-0000-4000-8000-000000000040", sourceIdentity: identity, sourceTab: "B2C" as const };
  const second = { financeRowId: "10000000-0000-4000-8000-000000000041", sourceIdentity: identity, sourceTab: "B2C" as const };

  const diff = previewFinanceImportVersion({ previous: [], replacement: [first, second] });

  expect(diff.newCandidates).toHaveLength(0);
  expect(diff.ambiguousCandidates).toHaveLength(2);
});
```

Also update the existing `"holds repeated same-key rows as ambiguous instead of merging them"` test to give all three rows `sourceTab: "B2C"`, so it keeps asserting real behavior rather than the absence of a field.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/b2c-finance-source-identity.test.ts`

Expected: FAIL — `sourceTab` is not a property of the row types.

- [ ] **Step 3: Thread `sourceTab` through the types**

In `src/server/services/b2c-finance-import-versioning.ts`:

```ts
export type FinanceImportSourceTab = "B2C" | "B2C Cons";

export type FinanceImportVersionPreviousRow = {
  financeRowId: string;
  sourceIdentity: string;
  lineageId: string;
  sourceTab: FinanceImportSourceTab;
};

export type FinanceImportVersionReplacementRow = {
  financeRowId: string;
  sourceIdentity: string | null;
  sourceTab: FinanceImportSourceTab;
};
```

- [ ] **Step 4: Classify the approved pair**

Replace the ambiguity branch in `previewFinanceImportVersion`. The approved pair is exactly two rows, one per tab, with no prior lineage and no represented payment:

```ts
    const isApprovedCrossTabPair =
      rows.length === 2 &&
      priorRows.length === 0 &&
      !representedPayment &&
      new Set(rows.map((row) => row.sourceTab)).size === 2;

    if (isApprovedCrossTabPair) {
      // One real payment recorded on both Finance sheets. It resolves to a
      // single lineage covering both immutable source rows -- it is NOT a
      // repeat, and holding it as ambiguous would make it permanently
      // unpostable (the database refuses confirm_new for ambiguous
      // candidates and link_revision needs a lineage that does not exist yet).
      newCandidates.push({
        candidateId: nextCandidateId("new", identity),
        financeRowIds: rows.map((row) => row.financeRowId),
        sourceIdentity: identity,
        priorLineageIds: [],
        priorPaymentIds: [],
        reason: "One approved B2C and B2C Cons row describe the same payment.",
      });
      continue;
    }

    if (rows.length > 1 || priorRows.length > 1) {
      // ...existing ambiguous branch unchanged...
    }
```

- [ ] **Step 5: Supply `sourceTab` at both call sites**

In `src/server/services/payment-tracker-upload.ts`, `buildReplacementRows` already maps over `assessment.rows`, which carry `sourceTab`:

```ts
  return assessment.rows.map((row, index) => ({
    financeRowId: rowIds[index],
    sourceTab: row.sourceTab,
    sourceIdentity: /* unchanged */,
  }));
```

In `src/server/repositories/b2c-finance-reconciliation-repository.ts`, add `source_tab` to the `getPreviousImportLineagedRows` select and map it through as `sourceTab`.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/b2c-finance-source-identity.test.ts tests/payment-tracker-upload-api.test.ts`

Expected: PASS.

- [ ] **Step 7: Add the pgTAP proof**

Add to `supabase/tests/database_foundation.test.sql` (bump `plan(N)` by 2): stage a first import containing one `B2C` and one `B2C Cons` row for the same identity, pass the merged `new` candidate, then assert (a) exactly one lineage exists for that identity, and (b) both `finance_row_id`s link to it. Follow the existing fixture style in that file.

- [ ] **Step 8: Verify and commit**

```bash
npm run supabase:test && npx vitest run && npm run typecheck && npm run lint
git add src/server/services/b2c-finance-import-versioning.ts \
  src/server/repositories/b2c-finance-reconciliation-repository.ts \
  src/server/services/payment-tracker-upload.ts \
  tests/b2c-finance-source-identity.test.ts supabase/tests/database_foundation.test.sql
git commit -m "fix(b2c): let an approved cross-tab exact pair resolve to one lineage"
```

---

### Task 4: First-import auto-link records its decision (D5)

`finalize_b2c_finance_import_version` auto-links first-import `new` candidates but never writes a decision row, while `get_b2c_finance_posting_readiness` counts every candidate lacking a decision. Those candidates stay visible forever, and deciding one later fails because its row is already linked.

The clean fix removes the duplication rather than patching around it: **insert the decision and let the existing `apply_b2c_finance_import_version_decision` trigger do the linking.** One code path, no phantom.

**Files:**
- Create: `supabase/migrations/20260820103000_b2c_exact_pair_and_candidate_decisions.sql`
- Modify: `supabase/tests/database_foundation.test.sql`

**Interfaces:**
- Consumes: the exact-pair candidate shape from Task 3 (a `new` candidate may carry two `financeRowIds`).
- Produces: after any first-ever import, zero candidates without a decision.

- [ ] **Step 1: Write the failing pgTAP assertion**

Add to `supabase/tests/database_foundation.test.sql` (bump `plan(N)` by 1):

```sql
select is(
  (select count(*)::int
     from public.b2c_finance_import_version_candidates candidates
     where not exists (
       select 1 from public.b2c_finance_import_version_decisions decisions
       where decisions.candidate_id = candidates.id
     )
     and candidates.candidate_kind = 'new'),
  0,
  'a first-ever import leaves no auto-confirmed candidate without its decision row'
);
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run supabase:test`

Expected: FAIL — auto-linked candidates currently have no decision row.

- [ ] **Step 3: Replace the auto-link with an auto-decision**

In the new migration, `create or replace` `finalize_b2c_finance_import_version`, changing only the first-import branch. Delete the manual lineage-insert and link-insert; insert a decision instead:

```sql
      -- The first-ever Payment Tracker import has no prior state to
      -- reconcile, so its unambiguous new identities are confirmed
      -- automatically -- but through the SAME decision path an Admin would
      -- use, not a parallel one. The apply_b2c_finance_import_version_decision
      -- trigger creates the lineage and links every finance_row_id. Writing
      -- the decision row is what keeps the candidate out of the pending
      -- readiness feed forever after.
      if not has_prior_payment_tracker_import and candidate_item ->> 'candidateKind' = 'new' then
        insert into public.b2c_finance_import_version_decisions (
          import_id, candidate_id, decision, reason
        ) values (
          import_id, candidate_id, 'confirm_new',
          'Automatically confirmed: the first Payment Tracker import has no prior version to reconcile against.'
        );
      end if;
```

Then confirm `apply_b2c_finance_import_version_decision` links **every** id in `finance_row_ids` (not just the first) — Task 3's approved pair depends on this. If it links only one, fix it here and note it in the Defect Register.

- [ ] **Step 4: Verify**

Run: `npm run supabase:test`

Expected: PASS, including Task 3's exact-pair assertions.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260820103000_b2c_exact_pair_and_candidate_decisions.sql \
  supabase/tests/database_foundation.test.sql
git commit -m "fix(b2c): record a decision for auto-confirmed first-import candidates"
```

---

### Task 5: Import-version candidates become resolvable work items (D4)

`/lineage-decisions` has zero frontend callers, and `b2c-workspace-repository.ts` builds work items only from posted ledger rows plus the readiness summary — pending candidates never become work items. New, ambiguous, and existing-manual candidates are invisible and unresolvable in the live workspace.

**Files:**
- Create: `src/features/b2c/b2c-import-version-decision.tsx`
- Modify: `src/server/services/b2c-work-items.ts`
- Modify: `src/server/repositories/b2c-workspace-repository.ts`
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Create: `tests/b2c-import-version-decision-ui.test.tsx`
- Modify: `tests/b2c-work-items.test.ts`

**Interfaces:**
- Consumes: `POST /api/admin/b2c/finance-imports/[importId]/lineage-decisions` with `{ decision, candidateId, targetLineageId?, targetPaymentId?, reason }` (already built, already tested).
- Produces: `B2cPendingCandidateWorkItem = { candidateId, importId, candidateKind, sourceIdentity, financeRowIds, priorLineageIds, priorPaymentIds }`, surfaced as work items with `visibleGroup: "reconciliation"` and `nextAction: "review_import_version"`.

- [ ] **Step 1: Write the failing work-item test**

Add to `tests/b2c-work-items.test.ts`:

```ts
it("turns an undecided import-version candidate into one reconciliation work item", () => {
  const items = buildB2cPendingCandidateWorkItems([{
    candidateId: "c1", importId: "i1", candidateKind: "new",
    sourceIdentity: "a".repeat(64),
    financeRowIds: ["r1"], priorLineageIds: [], priorPaymentIds: [],
    customerLabel: "Maya Al Khalifa", amountUsd: "399.000000", occurredOn: "2026-08-01",
  }]);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    queue: "reconciliation",
    visibleGroup: "reconciliation",
    nextAction: "review_import_version",
    recordKind: "finance_row",
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/b2c-work-items.test.ts`

Expected: FAIL — `buildB2cPendingCandidateWorkItems` does not exist.

- [ ] **Step 3: Build the work items**

In `src/server/services/b2c-work-items.ts`:

```ts
export type B2cPendingCandidateRecord = {
  candidateId: string;
  importId: string;
  candidateKind: "new" | "ambiguous" | "existing_payment";
  sourceIdentity: string;
  financeRowIds: string[];
  priorLineageIds: string[];
  priorPaymentIds: string[];
  customerLabel: string;
  amountUsd: string | null;
  occurredOn: string | null;
};

const CANDIDATE_EXPLANATION: Record<B2cPendingCandidateRecord["candidateKind"], string> = {
  new: "This replacement-workbook row has no prior Payment Tracker row or existing payment with the same identity. Confirm it as a genuinely new payment, or link it to the record it revises.",
  ambiguous: "Several rows share this payment identity, so PLAYBOOK cannot resolve them automatically. Decide each one explicitly.",
  existing_payment: "This workbook row matches an existing manual bank transfer. Link it as evidence -- it must never become a second payment.",
};

/** An undecided import-version candidate blocks its rows from posting until an Admin resolves it. */
export function buildB2cPendingCandidateWorkItems(records: B2cPendingCandidateRecord[]): B2cWorkItem[] {
  return records.map((record) => ({
    id: `candidate:${record.candidateId}`,
    recordId: record.candidateId,
    recordKind: "finance_row",
    queue: "reconciliation",
    visibleGroup: "reconciliation",
    financeMethod: null,
    title: `Resolve the Payment Tracker version decision for ${record.customerLabel}`,
    explanation: CANDIDATE_EXPLANATION[record.candidateKind],
    financialImpactUsd: record.amountUsd,
    nextAction: "review_import_version",
    href: `/operations/b2c?tab=work&candidate=${record.candidateId}`,
  }));
}
```

- [ ] **Step 4: Load candidates in the repository**

In `src/server/repositories/b2c-workspace-repository.ts`, add a loader that joins undecided candidates to one representative staging row for its label, and fold the result into `buildB2cWorkspaceOverview`. Query `b2c_finance_import_version_candidates` where no matching row exists in `b2c_finance_import_version_decisions` and `candidate_kind <> 'removed'`, then look up `b2c_finance_staging_rows` for `financeRowIds[0]` to fill `customerLabel`, `amountUsd`, and `occurredOn`.

- [ ] **Step 5: Write the failing drawer test**

Create `tests/b2c-import-version-decision-ui.test.tsx` asserting: all three decision options render for an Admin; `confirm_new` submits with no target; `link_existing_manual` requires a `targetPaymentId`; a reason under 3 characters keeps the submit disabled; and a Viewer sees the read-only note instead.

- [ ] **Step 6: Build the drawer fragment**

Create `src/features/b2c/b2c-import-version-decision.tsx`. It posts to the existing route, shows the candidate's kind-specific explanation, requires a reason, and disables submit until the chosen decision has its required target. Follow the dialog-free fragment pattern of `B2cPostedFinanceAdjustmentFragment` in the drawer — the drawer owns open/close/focus/refresh.

- [ ] **Step 7: Route to it from the drawer**

In `b2c-payment-review-drawer.tsx`, add a `{ kind: "candidate"; candidate: … }` target variant, and render `B2cImportVersionDecision` when `primary === "review_import_version"`. Replace the current informational placeholder text.

- [ ] **Step 8: Verify and commit**

```bash
npx vitest run && npm run typecheck && npm run lint
git add src/features/b2c/b2c-import-version-decision.tsx src/server/services/b2c-work-items.ts \
  src/server/repositories/b2c-workspace-repository.ts src/features/b2c/b2c-payment-review-drawer.tsx \
  tests/b2c-import-version-decision-ui.test.tsx tests/b2c-work-items.test.ts
git commit -m "feat(b2c): make import-version candidates resolvable from the Work queue"
```

---

### Task 6: Persist and surface provider-evidence mismatches (D6)

`reconcileProviderEvidence` computes `mismatches` and `unmatchedEvidence`, then both are discarded — the finalize routes ignore the return value and nothing recomputes it. The promised "amount/currency/date/status mismatch becomes a work-queue item" never happens.

**Files:**
- Create: `supabase/migrations/20260820110000_b2c_provider_evidence_mismatches.sql`
- Modify: `src/server/services/b2c-provider-evidence-reconciliation.ts`
- Modify: `src/app/api/admin/b2c/stripe-charges/finalize/route.ts` (call site of the renamed function)
- Modify: `src/app/api/admin/b2c/tap-statement/finalize/route.ts` (call site of the renamed function)
- Modify: `src/server/repositories/b2c-workspace-repository.ts`
- Modify: `src/server/services/b2c-work-items.ts`
- Modify: `tests/b2c-provider-evidence-reconciliation.test.ts`
- Modify: `tests/stripe-charges-upload-api.test.ts`, `tests/tap-statement-upload-api.test.ts` (they assert the current call)

**Interfaces:**
- Produces: `b2c_provider_evidence_payment_links.match_state` accepts `'exact_match' | 'mismatch'`, plus a `mismatch_fields text[]` column. Mismatches become work items with `nextAction: "compare"`.

- [ ] **Step 1: Relax the constraint and add the field**

In the new migration:

```sql
-- A mismatch is as much an audit fact as an exact match: same provider
-- transaction ID, disagreeing amount/currency/date/status. Recording it is
-- what lets the Work queue surface it; discarding it (the previous
-- behavior) silently loses the discrepancy.
alter table public.b2c_provider_evidence_payment_links
  drop constraint if exists b2c_provider_evidence_payment_links_match_state_check;

alter table public.b2c_provider_evidence_payment_links
  add constraint b2c_provider_evidence_payment_links_match_state_check
  check (match_state in ('exact_match', 'mismatch'));

alter table public.b2c_provider_evidence_payment_links
  add column if not exists mismatch_fields text[] not null default '{}';

alter table public.b2c_provider_evidence_payment_links
  add constraint b2c_provider_evidence_payment_links_mismatch_fields_check
  check (
    (match_state = 'exact_match' and cardinality(mismatch_fields) = 0)
    or (match_state = 'mismatch' and cardinality(mismatch_fields) > 0)
  );
```

- [ ] **Step 2: Write the failing test**

In `tests/b2c-provider-evidence-reconciliation.test.ts`, replace the "persists only the exact matches" assertion with one asserting mismatches persist too, carrying their `mismatch_fields`, while `unmatchedEvidence` still persists nothing (there is no payment to link to).

- [ ] **Step 3: Persist mismatches**

In `linkB2cProviderEvidenceExactMatches` (rename to `linkB2cProviderEvidence`), upsert mismatches alongside exact matches with `match_state: "mismatch"` and `mismatch_fields: match.fields`.

- [ ] **Step 4: Surface them as work items**

Load `match_state = 'mismatch'` links in the workspace repository and map each to a work item with `queue: "reconciliation"`, `nextAction: "compare"`, and an explanation naming the differing fields.

- [ ] **Step 5: Verify and commit**

```bash
npm run supabase:test && npx vitest run && npm run typecheck && npm run lint
git add supabase/migrations/20260820110000_b2c_provider_evidence_mismatches.sql \
  src/server/services/b2c-provider-evidence-reconciliation.ts \
  src/server/repositories/b2c-workspace-repository.ts src/server/services/b2c-work-items.ts \
  tests/b2c-provider-evidence-reconciliation.test.ts
git commit -m "feat(b2c): persist provider-evidence mismatches and surface them for review"
```

---

### Task 7: Split Finance-workbook duplicates from payment duplicates (D7)

Every `possible_duplicate` maps to `choose_duplicate`, and the drawer renders the Finance workbook exact-pair component for all of them. A flagged manual bank transfer or Stripe payment therefore has no correct keep/exclude workflow and stays blocked permanently.

**Files:**
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Modify: `src/lib/b2c/payment-decision.ts`
- Create: `tests/b2c-payment-duplicate-routing.test.tsx`

**Interfaces:**
- Produces: `B2cPaymentDecision.blockingReasons` distinguishes `possible_duplicate` (a `b2c_payments` content flag) from `finance_exact_duplicate` (an unresolved `b2c_reconciliation_groups` pair).

- [ ] **Step 1: Write the failing test**

Create `tests/b2c-payment-duplicate-routing.test.tsx`: a `finance_tracker` row with an unresolved cross-tab group renders the exact-pair review; a `manual_bank_transfer` row flagged `possible_duplicate` renders the payment-level keep/exclude flow and **not** the workbook component.

- [ ] **Step 2: Add the distinct blocking reason**

Add `"finance_exact_duplicate"` to `B2cBlockingReason`, set it when the row is `finance_tracker` with an unresolved reconciliation group, and keep `possible_duplicate` for the payment-level flag. Add its `reasonText` entry and a `REASON_PLAN` entry mapping it to `choose_duplicate`.

- [ ] **Step 3: Route each to its own fragment**

In the drawer, render `B2cExactDuplicateReview` only for `finance_exact_duplicate`. For `possible_duplicate`, render a payment-level fragment that resolves the review flag through the existing review-flag resolution route with a required reason.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run && npm run typecheck && npm run lint
git add src/features/b2c/b2c-payment-review-drawer.tsx src/lib/b2c/payment-decision.ts \
  tests/b2c-payment-duplicate-routing.test.tsx
git commit -m "fix(b2c): give payment-level duplicates their own review action"
```

---

### Task 8: Server-side ledger filtering (D8)

`b2c-workspace.tsx` sends only `period`, `limit`, and `cursor`; search/source/status/issue/amount filters run client-side over already-loaded rows, so results are wrong until every page is loaded. The server side already supports all of it — `b2cWorkspaceLedgerQuerySchema` validates these fields and `pageB2cLedgerRows` applies them. Only the client never sends them.

**Files:**
- Modify: `src/features/b2c/b2c-workspace.tsx`
- Modify: `tests/b2c-workspace-ui.test.tsx`

- [ ] **Step 1: Write the failing test**

Assert that changing the Source filter issues a fetch whose URL contains `source=`, and that the client does not filter locally (a row the server returned stays visible).

- [ ] **Step 2: Send the filters**

In `loadLedgerPage`, map filter state onto the query string (`search`, `source`, `sourceStatus`, `issue`, `minAmountUsd`, `maxAmountUsd`, `sort`), reset the cursor whenever filters change, and delete the local `filterRows` call so the server is the single source of truth.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run && npm run typecheck && npm run lint
git add src/features/b2c/b2c-workspace.tsx tests/b2c-workspace-ui.test.tsx
git commit -m "fix(b2c): filter the ledger server-side instead of per loaded page"
```

---

### Task 9: Require an explicit UTC offset on manual transfers (D9)

`p_received_at_raw::timestamptz` silently accepts a timestamp with no offset and resolves it in the session timezone, so an Admin outside Bahrain can record the wrong instant and therefore the wrong business date. The browser also assumes its own timezone when building the value.

**Files:**
- Create: `supabase/migrations/20260820113000_b2c_manual_transfer_offset_guard.sql`
- Modify: `src/features/b2c/b2c-manual-bank-transfer.tsx`
- Modify: `tests/b2c-manual-bank-transfer-ui.test.tsx`
- Modify: `supabase/tests/database_foundation.test.sql`

- [ ] **Step 1: Reject an offset-less timestamp in SQL**

In the new migration, `create or replace` `record_b2c_manual_bank_transfer` and add, before the cast:

```sql
  -- Postgres would resolve an offset-less timestamp in the session timezone,
  -- silently recording the wrong instant (and possibly the wrong Bahrain
  -- business date) for an Admin working elsewhere. Require the offset.
  if p_received_at_raw !~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    raise exception 'The bank transfer date/time must include an explicit UTC offset';
  end if;
```

- [ ] **Step 2: Make the offset explicit and visible in the UI**

In `b2c-manual-bank-transfer.tsx`, label the field with the timezone actually being applied and show the derived Bahrain business date in the Step 2 review, so the Admin confirms the date PLAYBOOK will record rather than inferring it.

- [ ] **Step 3: Add the pgTAP assertion**

Assert `record_b2c_manual_bank_transfer` raises when `p_received_at_raw` has no offset (bump `plan(N)` by 1).

- [ ] **Step 4: Verify and commit**

```bash
npm run supabase:test && npx vitest run && npm run typecheck && npm run lint
git add supabase/migrations/20260820113000_b2c_manual_transfer_offset_guard.sql \
  src/features/b2c/b2c-manual-bank-transfer.tsx tests/b2c-manual-bank-transfer-ui.test.tsx \
  supabase/tests/database_foundation.test.sql
git commit -m "fix(b2c): require an explicit UTC offset on a manual bank transfer"
```

---

### Task 10: Wire staging-row date authority into the drawer (D10)

`date-authority` resolves a staging row whose declared month/year conflicts with its parsed date. It works and is tested, but its only callers were deleted in Task 7 of the original plan, so no live UI reaches it.

**Files:**
- Create: `src/features/b2c/b2c-staging-date-authority.tsx`
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Modify: `src/server/repositories/b2c-workspace-repository.ts`
- Create: `tests/b2c-staging-date-authority-ui.test.tsx`

- [ ] **Step 1: Write the failing test**

Assert the fragment posts exactly one `financeRowId` per request (the route accepts exactly one reviewed row), requires a meaningful reason, and shows both the conflicting declared month/year and the parsed date before submitting.

- [ ] **Step 2: Build the fragment and surface the work item**

Create the fragment calling `POST /api/admin/b2c/finance-actions/date-authority`. In the workspace repository, surface staging rows carrying `declared_month_conflicts_with_date` / `declared_year_conflicts_with_date` as `data`-group work items with `nextAction: "correct"`, and route them to this fragment in the drawer.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run && npm run typecheck && npm run lint
git add src/features/b2c/b2c-staging-date-authority.tsx src/features/b2c/b2c-payment-review-drawer.tsx \
  src/server/repositories/b2c-workspace-repository.ts tests/b2c-staging-date-authority-ui.test.tsx
git commit -m "feat(b2c): resolve a staging-row date conflict from the shared drawer"
```

---

### Task 11: Full verification and status update

- [ ] **Step 1: Run everything**

```bash
npx vitest run && npm run typecheck && npm run lint && npm run build && npm run supabase:test
```

Expected: all five exit `0`.

- [ ] **Step 2: Re-audit for the same bug class**

```bash
python3 -c "
import os
for root,dirs,files in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in ('node_modules','.git','.next','old-project')]
    for f in files:
        if f.endswith(('.ts','.tsx','.sql')):
            p=os.path.join(root,f); data=open(p,'rb').read()
            if b'\x00' in data: print('RAW NUL BYTE:', p)
"
```

Expected: no output. Then `rg` for any formula still duplicated across TS and SQL without a parity test, and add one if found.

- [ ] **Step 3: Update the original plan's status**

Mark each defect resolved in the Defect Register above, and update the "Progress & amendments" section of `docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md` to reflect that the audit findings are closed.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/
git commit -m "docs(b2c): close the audit findings in the plan status"
```

---

## Still Out of Scope

These remain open after this plan and need a human, not code:

- **The wipe-and-reimport** of Payment Tracker, Stripe, and Tap data, then the reimport checklist in the "B2C Control Flow Review" artifact.
- **Correcting the Hoor Alshubbar payment** (`85edf4fe-346b-483a-8053-199e6b1e2961`, wrong date `2026-11-01`) through the now-live posted-adjustment flow.
- **Reconciling one real approved month** against Finance's own totals (Task 7 Step 5 of the original plan).
- **Playwright**: `tests/e2e/b2c-workspace-flow.spec.ts` exists but needs the dependency installed, a config, seeded fixtures, and non-OAuth auth fixtures. Its selectors were written against the pre-remediation UI and will need updating after Tasks 5, 7, and 10.
