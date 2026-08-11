# Target Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auditable Admin target-management feature that keeps approved financial targets separate from manual custom operational targets.

**Architecture:** Extend the financial-target definition table for approved USD financial goals and add separate operational target/progress tables for custom money or quantity goals. Server-side services and authenticated API routes own validation, authorization, revisions, and data access; the Finance UI only renders UI-safe target snapshots and submits validated forms.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Zod, Supabase PostgreSQL/RLS, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- B2C cash received, B2B bookings, B2B recognised sales, and total recognised sales remain separate measures.
- Financial actuals come only from verified reportable source records; while source history is incomplete, show `Actuals not fully loaded`, never zero or a manually entered actual.
- Custom operational targets may be USD money or a non-negative quantity with a required unit; manual progress requires a dated evidence note.
- Operational targets never contribute to financial totals, reports, or financial-performance charts.
- Money is decimal strings in TypeScript and `numeric(20,6)` in PostgreSQL; never use JavaScript floating point for financial calculations.
- Every user-initiated write is Admin-only through server checks and Supabase RLS using a request-scoped authenticated client.
- An active target is revised by archiving its current revision and inserting a successor; never silently overwrite it.
- Do not create delete policies for targets or target-progress history.
- Apply the migration manually in Supabase before testing live writes.

---

## File Structure

- `supabase/migrations/20260811100000_target_management.sql` — schema, RLS, audit triggers, constraints, and indexes.
- `src/types/database.generated.ts` — new table/column contracts.
- `src/lib/validation/target-contracts.ts` — strict Zod write contracts.
- `src/server/repositories/target-repository.ts` — Supabase reads/writes only.
- `src/server/services/target-management.ts` — target/revision/progress rules.
- `src/app/api/targets/route.ts` — approved-user reads.
- `src/app/api/admin/targets/**/route.ts` — Admin target creation, revision, and progress endpoints.
- `src/features/targets/target-management-page.tsx` — accessible UI states/forms/history.
- `src/app/finance/targets/page.tsx` and `src/components/app-shell.tsx` — page and navigation.
- `tests/target-management.test.ts` and `tests/ui-system.test.tsx` — services, authorization, and user-visible states.
- `docs/ARCHITECTURE.md`, `docs/PROJECT_STRUCTURE.md`, `docs/TESTING_STRATEGY.md` — completed-boundary documentation.

### Task 1: Add target schema and database protection

**Files:**

- Create: `supabase/migrations/20260811100000_target_management.sql`
- Modify: `src/types/database.generated.ts:166-170`
- Test: `supabase/tests/database_foundation.test.sql`

**Interfaces:**

- Produces `financial_targets`, `operational_targets`, and `operational_target_progress_updates` for later repository access.
- Financial rows contain `target_lineage_id`, `revision_number`, `status`, `finance_reference`, `revision_reason`, and `archived_at`.
- Operational rows contain the equivalent revision/status fields, `display_name`, `value_kind`, `target_value`, and `unit_label`.

- [ ] **Step 1: Write failing pgTAP cases**

Add a new database-foundation test block proving a quantity target without `unit_label` fails, an empty operational evidence note fails, and an unprivileged authenticated actor cannot insert either target kind.

```sql
select throws_ok(
  $$insert into public.operational_targets
      (display_name, value_kind, target_value, unit_label, period_start, period_end, finance_reference, revision_reason)
    values ('Tickets', 'quantity', 100, null, '2026-01-01', '2026-12-31', 'Summit plan', 'Approved target')$$,
  '23514',
  '%operational_target_quantity_unit_check%',
  'quantity targets require a unit label'
);
```

- [ ] **Step 2: Run the database test to prove it fails**

Run: `npm run supabase:test`

Expected: the new assertions fail because target constraints do not exist.

- [ ] **Step 3: Create the migration**

Define the two enums and extend the existing table exactly as follows; populate a lineage ID for any existing rows before making it required.

```sql
create type public.target_status as enum ('draft', 'active', 'archived');
create type public.operational_target_value_kind as enum ('money_usd', 'quantity');

alter table public.financial_targets
  add column target_lineage_id uuid,
  add column revision_number integer not null default 1 check (revision_number > 0),
  add column status public.target_status not null default 'draft',
  add column finance_reference text not null default 'Initial Finance target' check (char_length(trim(finance_reference)) > 0),
  add column revision_reason text not null default 'Initial target definition' check (char_length(trim(revision_reason)) > 0),
  add column archived_at timestamptz;
update public.financial_targets set target_lineage_id = id where target_lineage_id is null;
alter table public.financial_targets alter column target_lineage_id set not null;
alter table public.financial_targets alter column target_lineage_id set default gen_random_uuid();

create table public.operational_targets (
  id uuid primary key default gen_random_uuid(),
  target_lineage_id uuid not null default gen_random_uuid(),
  revision_number integer not null default 1 check (revision_number > 0),
  display_name text not null check (char_length(trim(display_name)) between 1 and 160),
  value_kind public.operational_target_value_kind not null,
  target_value numeric(20, 6) not null check (target_value >= 0),
  unit_label text,
  period_start date not null,
  period_end date not null,
  status public.target_status not null default 'draft',
  finance_reference text not null check (char_length(trim(finance_reference)) between 1 and 1000),
  revision_reason text not null check (char_length(trim(revision_reason)) between 1 and 1000),
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  constraint operational_target_quantity_unit_check check ((value_kind = 'quantity' and char_length(trim(coalesce(unit_label, ''))) > 0) or (value_kind = 'money_usd' and unit_label is null)),
  unique (target_lineage_id, revision_number)
);

create table public.operational_target_progress_updates (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.operational_targets(id),
  actual_value numeric(20, 6) not null check (actual_value >= 0),
  effective_on date not null,
  evidence_note text not null check (char_length(trim(evidence_note)) between 1 and 1000),
  entered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);
```

Drop the old `financial_targets_metric_code_period_start_period_end_key` constraint, replace it with a partial unique index across `metric_code, period_start, period_end` where status is `draft` or `active`, and add lineage/revision indexes. Add actor and `set_updated_at` triggers for operational definitions plus an actor trigger for progress rows. Attach existing audit triggers to new tables. Enable RLS; grant approved-user reads, Admin insert/update, and no delete policy. Add a before-update trigger that only permits the current active target to change from `active` to `archived` along with `archived_at` and audit-managed actor/timestamp columns; reject all other active-definition mutations.

- [ ] **Step 4: Regenerate database contracts**

After applying the migration to local Supabase, run:

```bash
npm run supabase:types
```

Verify the generated type includes the added financial-target fields and both operational tables, with `target_value` and `actual_value` typed as `Decimal`.

- [ ] **Step 5: Run database tests**

Run: `npm run supabase:test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260811100000_target_management.sql src/types/database.generated.ts supabase/tests/database_foundation.test.sql
git commit -m "feat(targets): add auditable target schema"
```

### Task 2: Add validation contracts and target business rules

**Files:**

- Create: `src/lib/validation/target-contracts.ts`
- Create: `src/server/services/target-management.ts`
- Test: `tests/target-management.test.ts`

**Interfaces:**

- Produces `financialTargetSchema`, `operationalTargetSchema`, and `operationalProgressSchema`.
- Produces `createFinancialTarget`, `createOperationalTarget`, `reviseFinancialTarget`, `reviseOperationalTarget`, and `recordOperationalProgress`.

- [ ] **Step 1: Write failing tests**

Test that an unknown financial metric, an empty Finance reference, a quantity target with no unit, and manual financial progress are rejected.

```ts
it("requires a quantity unit", () => {
  expect(operationalTargetSchema.safeParse({
    displayName: "Tickets", valueKind: "quantity", targetValue: "100",
    periodStart: "2026-01-01", periodEnd: "2026-12-31",
    status: "active", financeReference: "Summit plan", revisionReason: "Approved target",
  }).success).toBe(false);
});

it("rejects progress for a financial-target ID", async () => {
  await expect(recordOperationalProgress({
    targetId: FINANCIAL_TARGET_ID, actualValue: "10",
    effectiveOn: "2026-08-11", evidenceNote: "Finance workbook",
  }, repository)).rejects.toThrow("Operational target not found or inactive.");
});
```

- [ ] **Step 2: Run the focused test to prove it fails**

Run: `npm run test -- tests/target-management.test.ts`

Expected: FAIL because the contract/service modules are absent.

- [ ] **Step 3: Implement strict contracts**

Use decimal strings and only these finance metrics:

```ts
export const financialMetricCodeSchema = z.enum([
  "b2c_cash_received", "b2b_bookings", "b2b_recognised_sales", "total_recognised_sales",
]);
export const operationalProgressSchema = z.object({
  targetId: uuid, actualValue: nonNegativeMoney, effectiveOn: isoDate,
  evidenceNote: nonEmpty.max(1000),
}).strict();
```

The operational schema must reject `unitLabel` for `money_usd`, require it for `quantity`, and reject end dates before start dates. Both definition schemas must require a `draft` or `active` status, Finance reference, and revision reason.

- [ ] **Step 4: Implement repository-independent services**

Define a `TargetRepository` interface. The revise functions archive the prior active definition and insert a successor with the same lineage and `revisionNumber + 1`. The progress function only looks up an active operational target and inserts an append-only update.

```ts
export async function recordOperationalProgress(input: unknown, repository: TargetRepository) {
  const value = operationalProgressSchema.parse(input);
  const target = await repository.findOperationalTarget(value.targetId);
  if (!target || target.status !== "active") throw new Error("Operational target not found or inactive.");
  return repository.createOperationalProgress(value);
}
```

- [ ] **Step 5: Run focused tests**

Run: `npm run test -- tests/target-management.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/target-contracts.ts src/server/services/target-management.ts tests/target-management.test.ts
git commit -m "feat(targets): add validated target services"
```

### Task 3: Implement secured repository and API endpoints

**Files:**

- Create: `src/server/repositories/target-repository.ts`
- Create: `src/app/api/targets/route.ts`
- Create: `src/app/api/admin/targets/financial/route.ts`
- Create: `src/app/api/admin/targets/operational/route.ts`
- Create: `src/app/api/admin/targets/financial/[targetId]/revise/route.ts`
- Create: `src/app/api/admin/targets/operational/[targetId]/revise/route.ts`
- Create: `src/app/api/admin/targets/operational/[targetId]/progress/route.ts`
- Test: `tests/target-management.test.ts`

**Interfaces:**

- `GET /api/targets` returns UI-safe financial and operational target snapshots.
- Write routes accept only Admins and use one Task 2 service call per request.

- [ ] **Step 1: Write failing API tests**

Mock an unauthenticated user, a viewer, and an Admin. Assert that reads are approved-user only, writes return `403` for non-Admins, invalid bodies return `422`, and a successful progress POST returns `201` without database-error text.

```ts
expect(response.status).toBe(403);
expect(await response.json()).toEqual({ error: "Admin access is required." });
```

- [ ] **Step 2: Run tests to prove they fail**

Run: `npm run test -- tests/target-management.test.ts`

Expected: FAIL because repository/routes are absent.

- [ ] **Step 3: Implement the repository**

`SupabaseTargetRepository` takes a request-scoped `DatabaseClient`. Its methods omit all actor fields so database triggers use `auth.uid()`; they throw safe service errors rather than provider text.

```ts
const { data, error } = await this.client
  .from("operational_target_progress_updates")
  .insert({ target_id: input.targetId, actual_value: input.actualValue, effective_on: input.effectiveOn, evidence_note: input.evidenceNote })
  .select("id,actual_value,effective_on,evidence_note,entered_by,created_at")
  .single();
if (error) throw new Error("Could not save operational target progress.");
return data;
```

- [ ] **Step 4: Implement thin routes**

Every write route: create server client, call `auth.getUser()`, require `getApprovedRole(client, user.id) === "admin"`, parse JSON safely, validate input, call one service, then return `201` (create/progress) or `200` (revision). Return `{ error: "Admin access is required." }` at `403`, field validation errors at `422`, and `{ error: "The target could not be saved." }` for unexpected failures.

```ts
const client = await createServerSupabaseClient();
const { data: { user } } = await client.auth.getUser();
if (!user || await getApprovedRole(client, user.id) !== "admin") {
  return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
}
```

- [ ] **Step 5: Run focused tests**

Run: `npm run test -- tests/target-management.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/repositories/target-repository.ts src/app/api/targets src/app/api/admin/targets tests/target-management.test.ts
git commit -m "feat(targets): add secured target APIs"
```

### Task 4: Build the accessible Targets page

**Files:**

- Create: `src/features/targets/target-management-page.tsx`
- Create: `src/app/finance/targets/page.tsx`
- Modify: `src/components/app-shell.tsx:15-25`
- Modify: `tests/ui-system.test.tsx`

**Interfaces:**

- Consumes Task 3 API responses.
- Provides a separate financial-target view and operational-target view at `/finance/targets`.

- [ ] **Step 1: Write failing UI tests**

Test that financial targets say `Actuals not fully loaded` and do not show `$0.00`; an Admin can open `Add custom target`, choose `quantity`, enter a required unit, and see `Manual operational metric` after a database-backed refresh. Assert viewers see no create, revise, or progress buttons.

```tsx
expect(await screen.findByText("Actuals not fully loaded")).toBeInTheDocument();
expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
expect(screen.getByRole("button", { name: "Add custom target" })).toBeInTheDocument();
```

- [ ] **Step 2: Run UI tests to prove they fail**

Run: `npm run test -- tests/ui-system.test.tsx`

Expected: FAIL because the page is absent.

- [ ] **Step 3: Implement presentation and forms**

Use `AppShell` title `Targets` and a Finance navigation link `/finance/targets`. Use distinct `SectionCard` blocks. Financial cards display the approved goal and the fixed incomplete-actual state. Operational cards display the goal, latest manual actual, unit/USD, evidence/history, and `Manual operational metric`.

```tsx
<SectionCard title="Financial targets" description="Goals approved by Finance. Actuals are calculated only from verified source records.">
  <p className="text-sm font-medium text-text-secondary">Actuals not fully loaded</p>
  <p className="mt-1 text-sm text-text-muted">Financial progress will appear only after B2B and B2C history is complete and reconciled.</p>
</SectionCard>
<SectionCard title="Operational targets" description="Manual operational metrics are kept separate from financial reporting.">
  <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Manual operational metric</p>
</SectionCard>
```

Use visible labels, 44px minimum controls, `aria-live="polite"` save feedback, inline `ErrorState`, labelled modal dialogs, pending-state submit buttons, and no client-side authorization decision. Selecting quantity reveals the required unit; selecting money displays USD and removes the unit field.

- [ ] **Step 4: Connect API and refresh behavior**

Fetch `/api/targets` on mount, preserving loading, empty, and error states. After a successful create/revision/progress POST, re-fetch before closing the dialog. On failure, retain the dialog and show the safe returned error. Do not calculate any financial percentage. Operational display percentages are presentation-only and are labelled operational.

- [ ] **Step 5: Run UI tests**

Run: `npm run test -- tests/ui-system.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/targets/target-management-page.tsx src/app/finance/targets/page.tsx src/components/app-shell.tsx tests/ui-system.test.tsx
git commit -m "feat(targets): add auditable target management UI"
```

### Task 5: Document and verify the completed feature

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/superpowers/plans/2026-08-11-target-management.md`

**Interfaces:**

- Documents the Task 1–4 boundary and marks task checkboxes only after corresponding verification passes.

- [ ] **Step 1: Update documentation**

Document that approved financial targets have no manual actuals, custom operational targets are separate, and manual operational progress is append-only/audited. Add the targets feature/repository paths and target validation/RLS/revision tests.

- [ ] **Step 2: Run focused verification**

```bash
npm run test -- tests/target-management.test.ts
npm run test -- tests/ui-system.test.tsx
npm run typecheck
npm run lint
```

Expected: every command exits `0`.

- [ ] **Step 3: Run final verification**

```bash
npm run test
npm run build
git diff --check
git status --short
```

Expected: tests/build exit `0`, diff check is empty, and only intended docs are uncommitted before the final commit.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/PROJECT_STRUCTURE.md docs/TESTING_STRATEGY.md docs/superpowers/plans/2026-08-11-target-management.md
git commit -m "docs(targets): document target management boundary"
```

