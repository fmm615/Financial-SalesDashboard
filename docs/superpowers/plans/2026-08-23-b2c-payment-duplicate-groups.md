# B2C Payment Duplicate Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist B2C payment duplicate candidates as auditable groups, let an Admin atomically keep all or keep one, and keep Finance-workbook exact duplicates on their existing separate workflow.

**Architecture:** PostgreSQL owns candidate grouping, immutable resolution, historical backfill, and reporting eligibility. Request-scoped repositories and thin Admin routes expose safe group records; the shared B2C drawer renders separate payment-group and Finance-exact-group actions. Source payments remain immutable and an unresolved or excluded duplicate can never enter totals through a browser-only decision.

**Tech Stack:** PostgreSQL/Supabase migrations, RLS, PL/pgSQL, pgTAP, TypeScript, Next.js App Router, React, Zod, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-23-b2c-payment-duplicate-groups-design.md`

## Global Constraints

- Apply this plan only after `20260820110000_b2c_provider_evidence_mismatches.sql`.
- The new migration is `supabase/migrations/20260820111000_b2c_payment_duplicate_groups.sql`.
- Preserve every Stripe, Tap, manual-bank-transfer, and Finance source record; never delete or rewrite a source payment to resolve a duplicate.
- The approved content rule remains email + amount + category + business date within the preceding 48 hours; provider transaction ID remains the stronger exact identity.
- `keep_all` includes every group member; `keep_one` includes exactly the selected member and excludes every other member.
- An open group always blocks reporting. Any resolved `exclude` member outcome wins over resolved `include` outcomes.
- Finance exact duplicates remain in `b2c_reconciliation_groups`; payment duplicate groups contain only `b2c_payments` IDs.
- Admin writes use a request-scoped authenticated client. Viewers cannot read duplicate membership or execute decisions.
- Reasons must contain 3–1000 meaningful characters and cannot be placeholder dashes or `N/A`.
- No unbounded PostgREST `IN` filters; batch lists at 100 values with at most four concurrent requests.
- Do not stage `supabase/.temp/**`, `supabase/.branches/**`, `.worktrees/**`, or `tsconfig.tsbuildinfo`.

---

### Task 1: Database-owned payment duplicate groups

**Files:**
- Create: `supabase/migrations/20260820111000_b2c_payment_duplicate_groups.sql`
- Modify: `supabase/tests/database_foundation.test.sql`
- Modify: `tests/database-foundation.test.ts`
- Modify: `src/types/database.generated.ts`

**Interfaces:**
- Consumes: `public.b2c_payments`, `public.b2c_payment_local_overrides`, `public.review_flags`, `public.review_flag_resolutions`, `public.is_admin()`, `public.write_audit_event()`.
- Produces: `public.b2c_payment_duplicate_groups`, `public.b2c_payment_duplicate_group_members`.
- Produces: `public.open_b2c_payment_duplicate_group(p_payment_id uuid) returns uuid`.
- Produces: `public.resolve_b2c_payment_duplicate_group(p_group_id uuid, p_decision text, p_canonical_payment_id uuid, p_reason text) returns void`.
- Produces: `public.dismiss_stale_b2c_possible_duplicate_flag(p_flag_id uuid, p_reason text) returns void`.
- Produces: `public.get_b2c_payment_duplicate_reporting_states() returns table (payment_id uuid, has_open_duplicate boolean, has_duplicate_exclusion boolean)` for approved Admin/Viewer reporting without exposing membership.
- Produces generated row unions: group status `"open" | "resolved"`, group decision `"keep_all" | "keep_one" | null`, member decision `"pending" | "include" | "exclude"`.

- [ ] **Step 1: Add failing structural migration assertions**

Add this test to `tests/database-foundation.test.ts` before the migration exists:

```ts
it("creates an Admin-only, atomic B2C payment duplicate-group workflow", () => {
  const sql = migration("20260820111000_b2c_payment_duplicate_groups.sql");
  expect(sql).toContain("create table public.b2c_payment_duplicate_groups");
  expect(sql).toContain("create table public.b2c_payment_duplicate_group_members");
  expect(sql).toContain("create or replace function public.open_b2c_payment_duplicate_group");
  expect(sql).toContain("create or replace function public.resolve_b2c_payment_duplicate_group");
  expect(sql).toContain("create or replace function public.dismiss_stale_b2c_possible_duplicate_flag");
  expect(sql).toContain("create or replace function public.get_b2c_payment_duplicate_reporting_states");
  expect(sql).toContain("extensions.digest(");
  expect(sql).toContain("p_decision not in ('keep_all', 'keep_one')");
  expect(sql).toContain("public.is_admin()");
  expect(sql).toContain("public.write_audit_event()");

  const paymentTrigger = sql.indexOf("create trigger open_b2c_payment_duplicate_group_after_payment_write");
  expect(sql.lastIndexOf("create or replace function public.record_b2c_manual_bank_transfer")).toBeGreaterThan(paymentTrigger);
  expect(sql.lastIndexOf("create or replace function public.apply_b2c_payment_local_correction")).toBeGreaterThan(paymentTrigger);
});
```

- [ ] **Step 2: Run the structural test and confirm RED**

Run:

```bash
npx vitest run tests/database-foundation.test.ts
```

Expected: FAIL because `20260820111000_b2c_payment_duplicate_groups.sql` does not exist.

- [ ] **Step 3: Add failing pgTAP fixtures for lifecycle invariants**

Replace `select plan(96)` with `select plan(129)` and add exactly 33 assertions. Use fixtures with succeeded payments that exercise source/effective values independently. The first two assertions are:

```sql
select is(
  public.open_b2c_payment_duplicate_group('a1000000-0000-4000-8000-000000000001')::text,
  public.open_b2c_payment_duplicate_group('a1000000-0000-4000-8000-000000000002')::text,
  'repeated detection returns the same open payment duplicate group'
);

select throws_ok(
  $$ select public.resolve_b2c_payment_duplicate_group(
    current_setting('test.b2c_duplicate_group_id')::uuid,
    'keep_one',
    'a1000000-0000-4000-8000-000000000099',
    'Finance selected a payment outside the group.'
  ) $$,
  'P0001',
  'The selected canonical payment must belong to this duplicate group',
  'keep-one rejects a payment outside the group'
);
```

Add one independent assertion for each remaining case:

- Viewer construction rejection;
- Viewer resolution rejection;
- an approved Viewer receiving safe per-payment reporting booleans;
- that Viewer being unable to select group/member rows or receive group/member IDs;
- a group containing at least two distinct succeeded payments;
- a third proven payment extending the same open group;
- `keep_all` marking every member `include`;
- `keep_one` marking exactly one member `include` and all others `exclude`;
- review flags resolving only after no other open group remains;
- a resolved group rejecting a second decision;
- direct group insert rejection;
- direct group update rejection;
- direct group delete rejection;
- direct member insert rejection;
- direct member update rejection;
- direct member delete rejection;
- a payment being rejected from a second simultaneous open group;
- an excluded member remaining excluded when a later resolved group includes it;
- a stale orphan flag being dismissible only when no current candidate exists;
- a stale flag refusing dismissal when a current candidate exists;
- historical backfill leaving an unprovable flag open;
- equal effective USD amounts grouping even when source currencies/amounts differ;
- a payment without an effective USD amount remaining ungrouped;
- equal content on a different business date remaining ungrouped even inside 48 hours;
- a succeeded payment insert trigger constructing a group;
- a verified override write constructing a group from effective values;
- a completed same-fingerprint, same-member set never reopening;
- member audit events carrying a non-null member record ID;
- a placeholder-only resolution reason being rejected;
- `keep_all` rejecting a non-null canonical payment;
- `keep_one` rejecting a null canonical payment.

- [ ] **Step 4: Run pgTAP and confirm RED**

Run:

```bash
npm run supabase:test
```

Expected: FAIL because the group tables/functions do not exist.

- [ ] **Step 5: Create constrained group and member tables**

Start the migration with these concrete states and checks:

```sql
create table public.b2c_payment_duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'resolved')),
  decision text check (decision in ('keep_all', 'keep_one')),
  canonical_payment_id uuid references public.b2c_payments(id),
  detection_reason text not null check (char_length(trim(detection_reason)) between 3 and 1000),
  resolution_reason text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (
    (status = 'open' and decision is null and canonical_payment_id is null and resolution_reason is null and resolved_by is null and resolved_at is null)
    or
    (status = 'resolved' and decision = 'keep_all' and canonical_payment_id is null and char_length(trim(resolution_reason)) between 3 and 1000 and resolved_by is not null and resolved_at is not null)
    or
    (status = 'resolved' and decision = 'keep_one' and canonical_payment_id is not null and char_length(trim(resolution_reason)) between 3 and 1000 and resolved_by is not null and resolved_at is not null)
  )
);

create unique index b2c_payment_duplicate_groups_one_open_fingerprint_idx
  on public.b2c_payment_duplicate_groups (fingerprint)
  where status = 'open';

create table public.b2c_payment_duplicate_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.b2c_payment_duplicate_groups(id),
  payment_id uuid not null references public.b2c_payments(id),
  decision text not null default 'pending' check (decision in ('pending', 'include', 'exclude')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (group_id, payment_id)
);
```

Enable RLS, grant Admin-visible `select` only through `using (public.is_admin())`, revoke anonymous/public access, and attach `write_audit_event()` triggers to both tables.

- [ ] **Step 6: Add the SQL-authoritative effective fingerprint helper**

Create a private helper that reads the payment and its local override and returns normalized facts:

```sql
create or replace function public.get_effective_b2c_duplicate_facts(p_payment_id uuid)
returns table (
  payment_id uuid,
  customer_email text,
  comparison_amount numeric(20, 6),
  category_code text,
  occurred_at timestamptz,
  occurred_on date,
  fingerprint text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id,
    lower(trim(coalesce(o.customer_email, p.customer_email)::text)),
    coalesce(o.local_amount_usd, p.amount_usd),
    lower(trim(coalesce(o.category_code, p.category_code))),
    p.occurred_at,
    coalesce(o.local_occurred_on, p.occurred_on),
    encode(extensions.digest(
      lower(trim(coalesce(o.customer_email, p.customer_email)::text)) || '|' ||
      'USD|' ||
      coalesce(o.local_amount_usd, p.amount_usd)::numeric(20, 6)::text || '|' ||
      lower(trim(coalesce(o.category_code, p.category_code))) || '|' ||
      coalesce(o.local_occurred_on, p.occurred_on)::text,
      'sha256'
    ), 'hex')
  from public.b2c_payments p
  left join public.b2c_payment_local_overrides o on o.payment_id = p.id
  where p.id = p_payment_id
    and p.payment_status = 'succeeded'
    and coalesce(o.customer_email, p.customer_email) is not null
    and coalesce(o.local_amount_usd, p.amount_usd) is not null
    and coalesce(o.category_code, p.category_code) is not null;
$$;
```

Use the schema-qualified `extensions.digest` shown above so a fixed search path cannot reproduce the earlier pgcrypto failure. Revoke direct execution from `public`, `anon`, and `authenticated`; only the protected constructor calls it.

- [ ] **Step 7: Implement idempotent group construction**

Implement `open_b2c_payment_duplicate_group` as a `security definer` function that:

```sql
if coalesce(auth.role(), '') = 'service_role' then
  null;
elsif auth.uid() is null and auth.role() is null then
  null;
elsif auth.uid() is null or not public.is_admin() then
  raise exception 'Only an authenticated administrator or trusted database session can create B2C payment duplicate groups';
end if;
```

Then lock the target payment, obtain its effective facts, take `pg_advisory_xact_lock(hashtext('b2c_payment_duplicate:' || fingerprint))`, and select candidate IDs with:

```sql
candidate.payment_id <> target.payment_id
and candidate.customer_email = target.customer_email
and candidate.comparison_amount = target.comparison_amount
and candidate.category_code = target.category_code
and candidate.occurred_on = target.occurred_on
and candidate.occurred_at between target.occurred_at - interval '48 hours' and target.occurred_at + interval '48 hours'
```

Exclude payments with any resolved member `decision = 'exclude'`. The comparison uses effective USD amount; a payment without verified USD amount is not a provable candidate. Provider identity remains stronger: never add a second row for the same `(source_system, provider_transaction_id)` identity.

Return `null` when fewer than two distinct IDs remain. If the target already belongs to an open group, preserve that detection-time case. Otherwise lock the open group for the same fingerprint: insert any newly proven, still-eligible members into that group and upsert their flags, then return its ID. This is how a third payment extends an unresolved case without creating an overlapping group. If the latest resolved same-fingerprint group contains exactly the same candidate ID set, return `null` without reopening it or creating flags; `null` means there is no current open case. Otherwise create one open group, insert every candidate member as `pending`, and upsert one open `possible_duplicate` flag per member.

Reject adding any candidate already present in a different open group. Use sorted payment IDs for deterministic row locking. Revoke execution from `public` and `anon`; grant it only to `authenticated` and `service_role`.

- [ ] **Step 8: Attach authoritative detection triggers**

Create trigger wrappers that call the constructor after:

```sql
create trigger open_b2c_payment_duplicate_group_after_payment_write
  after insert or update of payment_status, customer_email, category_code, amount_usd, occurred_at, occurred_on
  on public.b2c_payments
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_payment_write();

create trigger open_b2c_payment_duplicate_group_after_override_write
  after insert or update of customer_email, category_code, local_amount_usd, local_occurred_on
  on public.b2c_payment_local_overrides
  for each row execute procedure public.open_b2c_payment_duplicate_group_after_override_write();
```

The wrappers return `new` and always call the constructor; they must not swallow errors. Trusted migration/seed sessions have both `auth.uid()` and `auth.role()` null and are allowed by Step 7, while anonymous PostgREST sessions have role `anon` and are rejected. If the written payment already belongs to an open group, the constructor leaves that detection-time case unchanged; a newly inserted third payment still extends the existing same-fingerprint group.

- [ ] **Step 9: Remove the legacy SQL-side duplicate writers**

In the same forward migration, `create or replace` the current signatures of:

```sql
public.record_b2c_manual_bank_transfer(text, text, text, text, text, text, text, text, text)
public.apply_b2c_payment_local_correction(uuid, text, text, text, text, text, numeric, date, text)
```

Copy their latest bodies from `20260820100000_b2c_shared_identity_canonicalization.sql` and `20260805110000_extend_b2c_local_payment_corrections.sql`, respectively. Preserve every authentication, validation, preview-hash, Finance-lineage, source-identity, audit, missing-data-resolution, and immutable-write behavior. Remove only:

- `possible_match_count` and the pre-insert fingerprint candidate query plus post-insert `possible_duplicate` insert from the manual-transfer function; and
- `duplicate_payment_id` plus the final candidate loop/direct flag inserts from the local-correction function.

Their payment/override writes now invoke the Step 8 triggers in the same transaction. Add structural assertions that the replacement bodies appear after the trigger definitions, and use the different-business-date fixture from Step 3 to prove the former correction loop cannot create an orphan false-positive flag.

- [ ] **Step 10: Implement the atomic resolver**

Implement `resolve_b2c_payment_duplicate_group` with Admin check, placeholder-resistant reason validation, group/member locks, and these exact outcomes:

```sql
if char_length(trim(coalesce(p_reason, ''))) not between 3 and 1000
  or lower(trim(p_reason)) in ('n/a', 'na')
  or trim(p_reason) ~ '^[-—]+$' then
  raise exception 'A meaningful duplicate decision reason between 3 and 1000 characters is required';
end if;
```

```sql
update public.b2c_payment_duplicate_group_members
set decision = case
  when p_decision = 'keep_all' or payment_id = p_canonical_payment_id then 'include'
  else 'exclude'
end
where group_id = p_group_id and decision = 'pending';

update public.b2c_payment_duplicate_groups
set status = 'resolved',
    decision = p_decision,
    canonical_payment_id = case when p_decision = 'keep_one' then p_canonical_payment_id else null end,
    resolution_reason = trim(p_reason),
    resolved_by = auth.uid(),
    resolved_at = timezone('utc', now())
where id = p_group_id and status = 'open';
```

Validate `keep_all` requires a null canonical ID and `keep_one` requires exactly one member ID. Resolve each member's open `possible_duplicate` flag only when no other open group contains that payment. After resolving, call the constructor for each included member so a value changed during review can open a new case without reopening history.

- [ ] **Step 11: Implement guarded stale legacy dismissal**

`dismiss_stale_b2c_possible_duplicate_flag` must apply the same Admin and meaningful-reason validation as the resolver, lock an open B2C payment `possible_duplicate` flag, reject any flag already attached to an open group, rerun the constructor, and reject dismissal if the constructor finds a current group. Only then insert one `review_flag_resolutions` row with status `dismissed` and the Admin's reason.

- [ ] **Step 12: Expose safe duplicate reporting states to approved users**

Create `get_b2c_payment_duplicate_reporting_states()` as a `security definer`, `stable` SQL function. It checks `auth.uid() is not null and public.is_approved_user()`, then returns one row per member payment with:

```sql
bool_or(g.status = 'open') as has_open_duplicate,
bool_or(g.status = 'resolved' and m.decision = 'exclude') as has_duplicate_exclusion
```

Grant execution to `authenticated`. Do not return group IDs, fingerprints, decisions for other payments, reasons, actors, or member lists.

- [ ] **Step 13: Add fail-closed historical backfill**

At migration end, loop over existing open B2C payment duplicate flags and call the constructor:

```sql
do $$
declare
  flagged_payment_id uuid;
  ungrouped_flag_count integer;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  for flagged_payment_id in
    select distinct source_record_id
    from public.review_flags
    where source_area = 'b2c_payment'
      and flag_type = 'possible_duplicate'
      and status = 'open'
    order by source_record_id
  loop
    perform public.open_b2c_payment_duplicate_group(flagged_payment_id);
  end loop;

  select count(*) into ungrouped_flag_count
  from public.review_flags flag
  where flag.source_area = 'b2c_payment'
    and flag.flag_type = 'possible_duplicate'
    and flag.status = 'open'
    and not exists (
      select 1
      from public.b2c_payment_duplicate_group_members member
      join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
      where member.payment_id = flag.source_record_id
        and duplicate_group.status = 'open'
    );
  raise notice 'Ungrouped open B2C possible_duplicate flags retained for manual review: %', ungrouped_flag_count;
end;
$$;
```

Do not resolve or delete any flag when the constructor returns null. The notice is the production handoff count; it must be copied from Supabase SQL Editor after application.

- [ ] **Step 14: Update generated database types**

Add both table snapshots and all four RPC argument/return types to `src/types/database.generated.ts`, including the snake-case boolean rows returned by `get_b2c_payment_duplicate_reporting_states`. Use string unions matching the migration and keep money fields as decimal strings.

- [ ] **Step 15: Reset and verify the database**

Run:

```bash
npm run supabase:reset
npm run supabase:test
npx vitest run tests/database-foundation.test.ts
```

Expected: clean reset, all pgTAP assertions PASS, structural test PASS.

- [ ] **Step 16: Request review and commit Task 1**

Review database security, trigger recursion, lock order, idempotency, historical backfill, and exclusion precedence. Then:

```bash
git add supabase/migrations/20260820111000_b2c_payment_duplicate_groups.sql \
  supabase/tests/database_foundation.test.sql tests/database-foundation.test.ts \
  src/types/database.generated.ts
git commit -m "feat(b2c): persist auditable payment duplicate groups"
```

---

### Task 2: Reporting and decision facts

**Files:**
- Modify: `src/lib/b2c/payment-reportability.ts`
- Modify: `src/lib/b2c/payment-decision.ts`
- Modify: `src/server/repositories/b2c-dashboard-repository.ts`
- Modify: `src/server/repositories/b2c-ledger-repository.ts`
- Modify: `tests/b2c-payment-decision.test.ts`
- Modify: `tests/b2c-payment-reportability.test.ts`
- Modify: `tests/b2c-effective-payment.test.ts`
- Create: `tests/b2c-ledger-repository.test.ts`

**Interfaces:**
- Consumes: member states from Task 1.
- Produces: `B2cPaymentReportabilityInput.hasOpenPaymentDuplicate?: boolean` and `hasDuplicateExclusion?: boolean`, carried through `B2cPaymentDecisionInput`.
- Produces: `B2cBlockingReason` values `possible_duplicate` and `duplicate_exclusion`; Finance exact groups are pre-payment Work items in Task 4, not payment-decision state.
- Produces: safe ledger fields `hasOpenPaymentDuplicate: boolean`, `hasDuplicateExclusion: boolean`.

- [ ] **Step 1: Write failing domain tests**

Add to `tests/b2c-payment-decision.test.ts`:

```ts
it("keeps an open payment duplicate group blocked independently of raw review-flag translation", () => {
  const decision = resolveB2cPaymentDecision({
    ...base, openFlagTypes: new Set(), hasOpenPaymentDuplicate: true,
  });
  expect(decision).toMatchObject({
    reconciliationStatus: "duplicate_pending",
    reportingDecision: "blocked",
  });
  expect(decision.blockingReasons).toContain("possible_duplicate");
});

it("keeps an explicitly excluded duplicate outside reporting after its flag closes", () => {
  const decision = resolveB2cPaymentDecision({
    ...base, openFlagTypes: new Set(), hasDuplicateExclusion: true,
  });
  expect(decision.reportingDecision).toBe("excluded");
  expect(decision.blockingReasons).toContain("duplicate_exclusion");
});
```

Add a precedence test proving `hasDuplicateExclusion: true` remains excluded even when a later group inclusion exists.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
npx vitest run tests/b2c-payment-decision.test.ts tests/b2c-payment-reportability.test.ts tests/b2c-effective-payment.test.ts
```

Expected: TypeScript/test failure because the new inputs/reasons do not exist.

- [ ] **Step 3: Extend the decision model**

Add the two inputs and reasons to the shared reportability gate. Extend `B2cPaymentExclusionReason` with `duplicate_exclusion` and add:

```ts
if (input.hasOpenPaymentDuplicate && !reasons.includes("possible_duplicate")) reasons.push("possible_duplicate");
if (input.hasDuplicateExclusion) reasons.push("duplicate_exclusion");
```

Pass both facts through `toGateInput`, translate `duplicate_exclusion`, and keep the existing `Set` conversion so a raw legacy flag plus an open group produces one `possible_duplicate` reason. Set `reconciliationStatus` to `duplicate_pending` when the open group/flag exists. Set `reportingDecision` to `excluded` when `hasDuplicateExclusion` is true, using explanation text “an audited duplicate exclusion.” Do not add a `finance_exact_duplicate` payment reason: Task 4 represents that pre-payment Finance group directly.

- [ ] **Step 4: Load duplicate state with the dashboard snapshot**

Load one approved-user-safe RPC result with the snapshot:

```ts
client.rpc("get_b2c_payment_duplicate_reporting_states")
```

Build:

```ts
const openDuplicatePaymentIds = new Set<string>();
const excludedDuplicatePaymentIds = new Set<string>();
```

Map `has_open_duplicate` and `has_duplicate_exclusion` into the two sets. Pass both facts into every reportability calculation and ledger projection. Do not expose group membership or other payment IDs on Viewer ledger rows.

- [ ] **Step 5: Update ledger decoration**

Pass the safe booleans from `B2cLedgerRow` into `resolveB2cPaymentDecision`. Keep raw `possible_duplicate` flag translation only for ungrouped historical flags, so those remain blocked.

- [ ] **Step 6: Verify focused reporting tests**

Run:

```bash
npx vitest run tests/b2c-payment-decision.test.ts tests/b2c-payment-reportability.test.ts tests/b2c-effective-payment.test.ts tests/b2c-ledger-repository.test.ts
```

Expected: PASS.

- [ ] **Step 7: Request review and commit Task 2**

Review exclusion precedence and every totals path. Then:

```bash
git add src/lib/b2c/payment-decision.ts src/lib/b2c/payment-reportability.ts \
  src/server/repositories/b2c-dashboard-repository.ts src/server/repositories/b2c-ledger-repository.ts \
  tests/b2c-payment-decision.test.ts tests/b2c-ledger-repository.test.ts \
  tests/b2c-payment-reportability.test.ts tests/b2c-effective-payment.test.ts
git commit -m "fix(b2c): apply payment duplicate decisions to reportability"
```

---

### Task 3: Admin duplicate-group repository and APIs

**Files:**
- Create: `src/lib/validation/b2c-payment-duplicate-contracts.ts`
- Create: `src/server/repositories/b2c-payment-duplicate-repository.ts`
- Create: `src/server/services/b2c-payment-duplicate-review.ts`
- Create: `src/app/api/admin/b2c/payments/[paymentId]/duplicate-group/route.ts`
- Create: `src/app/api/admin/b2c/payment-duplicate-groups/[groupId]/decision/route.ts`
- Create: `src/app/api/admin/b2c/review-flags/[flagId]/dismiss-stale-duplicate/route.ts`
- Create: `tests/b2c-payment-duplicate-api.test.ts`
- Create: `tests/b2c-payment-duplicate-review.test.ts`

**Interfaces:**
- Consumes: Task 1 RPCs and tables.
- Produces: `b2cPaymentDuplicateDecisionSchema` with `{ decision: "keep_all" | "keep_one"; canonicalPaymentId: string | null; reason: string }`.
- Produces: `B2cPaymentDuplicateGroupReview` and `B2cPaymentDuplicateMemberReview` UI-safe records.
- Produces read response union `{ kind: "group"; group: B2cPaymentDuplicateGroupReview } | { kind: "ungrouped_flag"; flagId: string } | { kind: "none" }`.
- Produces routes: `GET /api/admin/b2c/payments/:paymentId/duplicate-group`, `POST /api/admin/b2c/payment-duplicate-groups/:groupId/decision`, `POST /api/admin/b2c/review-flags/:flagId/dismiss-stale-duplicate`.
- Produces successful decision response `{ groupId: string; resolvedPaymentIds: string[] }` for optimistic Work-queue removal.

- [ ] **Step 1: Write failing validation and mapping tests**

In `tests/b2c-payment-duplicate-review.test.ts`, assert:

```ts
expect(b2cPaymentDuplicateDecisionSchema.safeParse({
  decision: "keep_one",
  canonicalPaymentId: "11111111-1111-4111-8111-111111111111",
  reason: "Finance verified the retained provider receipt.",
}).success).toBe(true);

expect(b2cPaymentDuplicateDecisionSchema.safeParse({
  decision: "keep_all", canonicalPaymentId: null, reason: "---",
}).success).toBe(false);

expect(b2cPaymentDuplicateDecisionSchema.safeParse({
  decision: "keep_all",
  canonicalPaymentId: "11111111-1111-4111-8111-111111111111",
  reason: "Both receipts are separate payments.",
}).success).toBe(false);
```

Test the mapper omits `source_metadata`, Stripe evidence, audit actor email, and raw payloads.

- [ ] **Step 2: Run mapping tests and confirm RED**

Run:

```bash
npx vitest run tests/b2c-payment-duplicate-review.test.ts
```

Expected: FAIL because contracts/services do not exist.

- [ ] **Step 3: Implement strict validation contracts**

Use a discriminated union:

```ts
const reason = z.string().trim().min(3).max(1000)
  .refine((value) => !/^(?:-+|—+|n\/?a)$/i.test(value), "Enter a meaningful duplicate decision reason.");

export const b2cPaymentDuplicateDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("keep_all"), canonicalPaymentId: z.null(), reason }).strict(),
  z.object({ decision: z.literal("keep_one"), canonicalPaymentId: z.string().uuid(), reason }).strict(),
]);
```

Create a separate strict stale-dismissal schema `{ reason }`.

- [ ] **Step 4: Implement the repository and safe service mapper**

The repository method:

```ts
getOpenGroupForPayment(paymentId: string): Promise<B2cPaymentDuplicateGroupRow | null>
```

must select one open group, its members, only these payment columns—`id,source_system,provider_transaction_id,customer_name,customer_email,original_amount,original_currency,amount_usd,category_code,occurred_on,payment_status`—and the nested override columns `customer_name,customer_email,local_amount_usd,category_code,local_occurred_on`. It must reject multiple open groups as a database invariant failure. The mapper coalesces the same effective facts as the SQL helper and rejects a malformed group member if any comparison fact is missing.

Add:

```ts
getOpenPossibleDuplicateFlagForPayment(paymentId: string): Promise<{ id: string } | null>
```

It selects only `id` from an open `b2c_payment`/`possible_duplicate` flag. The GET service first loads the group; only when none exists does it load this flag and return the discriminated `ungrouped_flag` response. It never returns a flag ID alongside group membership.

Map to:

```ts
export type B2cPaymentDuplicateMemberReview = {
  paymentId: string;
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";
  providerReference: string | null;
  customerName: string | null;
  sourceCustomerEmail: string | null;
  effectiveCustomerEmail: string;
  sourceAmount: string;
  sourceCurrency: string;
  effectiveAmountUsd: string;
  sourceCategoryCode: string | null;
  effectiveCategoryCode: string;
  sourceOccurredOn: string | null;
  effectiveOccurredOn: string;
};

export type B2cPaymentDuplicateGroupReview = {
  groupId: string;
  detectionReason: string;
  members: B2cPaymentDuplicateMemberReview[];
};
```

Sort members by `effectiveOccurredOn`, then `paymentId` for stable review rendering. The service must not return the nested override object itself; it returns only the explicit source/effective fields above.

- [ ] **Step 5: Write failing API authorization and payload tests**

In `tests/b2c-payment-duplicate-api.test.ts`, test each route rejects unauthenticated and Viewer requests before repository/RPC access. Test invalid UUIDs and malformed bodies return 422. Test the Admin GET returns `group`, `ungrouped_flag`, and `none` variants correctly, and never queries the fallback flag when a group exists. Test Admin resolution calls:

```ts
client.rpc("resolve_b2c_payment_duplicate_group", {
  p_group_id: groupId,
  p_decision: "keep_one",
  p_canonical_payment_id: paymentId,
  p_reason: "Finance verified the retained provider receipt.",
});
```

Assert repository/RPC errors return safe messages without raw SQL or source content.

- [ ] **Step 6: Run API tests and confirm RED**

Run:

```bash
npx vitest run tests/b2c-payment-duplicate-api.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 7: Implement thin Admin routes**

Every route must authenticate with `client.auth.getUser()`, require `getApprovedRole(...) === "admin"`, validate path UUIDs with Zod, parse strict bodies, call one repository/RPC method, and return only safe errors. Before resolution, load the safe group so the route can return its member IDs after the RPC succeeds. Return 200 for reads, `201` with `{ groupId, resolvedPaymentIds }` for a saved decision, and 200 for a stale dismissal.

- [ ] **Step 8: Verify focused API tests**

Run:

```bash
npx vitest run tests/b2c-payment-duplicate-review.test.ts tests/b2c-payment-duplicate-api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Request review and commit Task 3**

Review RLS boundary, safe payloads, strict validation, and absence of raw provider payloads. Then:

```bash
git add src/lib/validation/b2c-payment-duplicate-contracts.ts \
  src/server/repositories/b2c-payment-duplicate-repository.ts \
  src/server/services/b2c-payment-duplicate-review.ts \
  'src/app/api/admin/b2c/payments/[paymentId]/duplicate-group/route.ts' \
  'src/app/api/admin/b2c/payment-duplicate-groups/[groupId]/decision/route.ts' \
  'src/app/api/admin/b2c/review-flags/[flagId]/dismiss-stale-duplicate/route.ts' \
  tests/b2c-payment-duplicate-api.test.ts tests/b2c-payment-duplicate-review.test.ts
git commit -m "feat(b2c): expose protected payment duplicate decisions"
```

---

### Task 4: Separate Work-queue targets for payment and Finance duplicates

**Files:**
- Modify: `src/server/services/b2c-work-items.ts`
- Modify: `src/server/repositories/b2c-workspace-repository.ts`
- Modify: `src/server/repositories/b2c-exact-duplicate-reconciliation-repository.ts`
- Modify: `src/server/services/b2c-exact-duplicate-review.ts`
- Modify: `src/app/api/admin/b2c/reconciliation/exact-duplicates/route.ts`
- Modify: `src/features/b2c/b2c-workspace.tsx`
- Modify: `tests/b2c-work-items.test.ts`
- Modify: `tests/b2c-workspace-api.test.ts`
- Modify: `tests/b2c-workspace-ui.test.tsx`
- Modify: `tests/b2c-exact-duplicate-reconciliation-api.test.ts`

**Interfaces:**
- Consumes: open payment group facts from Task 2 and existing `AdminExactDuplicateGroup`.
- Produces: `B2cWorkItem.nextAction` values `choose_payment_duplicate` and `choose_finance_duplicate`; remove ambiguous `choose_duplicate`.
- Produces: `B2cWorkspaceOverview.financeDuplicateGroups?: AdminExactDuplicateGroup[]`.
- Produces URLs `?record=<paymentId>` for payment groups and `?financeDuplicate=<groupId>` for Finance groups.

- [ ] **Step 1: Write failing work-item separation tests**

Import `AdminExactDuplicateGroup` from `b2c-exact-duplicate-review` and add to `tests/b2c-work-items.test.ts`:

```ts
const financeRow = (
  financeRowId: string,
  sourceTab: "B2C" | "B2C Cons",
): AdminExactDuplicateGroup["rows"][number] => ({
  financeRowId,
  sourceTab,
  sourceRowNumber: sourceTab === "B2C" ? 12 : 33,
  occurredOn: "2026-08-01",
  amountUsd: "100.000000",
  customerName: "Maya Al Khalifa",
  customerEmail: "member@example.com",
  customerPhone: null,
  category: "membership",
  paymentMethod: "Stripe",
});

it("routes payment duplicate groups and Finance exact groups to different drawer targets", () => {
  const financeGroup: AdminExactDuplicateGroup = {
    groupId: "group-1",
    state: "exact_duplicate_candidate",
    rows: [
      financeRow("finance-row-1", "B2C"),
      financeRow("finance-row-2", "B2C Cons"),
    ],
  };
  const paymentItems = buildB2cRecordWorkItems(record({
    decision: resolveB2cPaymentDecision({ ...succeededBase, hasOpenPaymentDuplicate: true }),
  }));
  const financeItems = buildB2cFinanceExactDuplicateWorkItems([financeGroup]);

  expect(paymentItems[0]).toMatchObject({
    nextAction: "choose_payment_duplicate",
    href: "/operations/b2c?tab=work&record=payment-1",
  });
  expect(financeItems[0]).toMatchObject({
    nextAction: "choose_finance_duplicate",
    href: "/operations/b2c?tab=work&financeDuplicate=group-1",
  });
});
```

- [ ] **Step 2: Run work-item tests and confirm RED**

Run:

```bash
npx vitest run tests/b2c-work-items.test.ts
```

Expected: FAIL because the distinct actions/builder do not exist.

- [ ] **Step 3: Add distinct work-item records and builders**

Map `possible_duplicate` to `choose_payment_duplicate` and update every existing `choose_duplicate` expectation in `tests/b2c-work-items.test.ts`. Add:

```ts
export function buildB2cFinanceExactDuplicateWorkItems(groups: AdminExactDuplicateGroup[]): B2cWorkItem[] {
  return groups.map((group) => ({
    id: `finance-exact-duplicate:${group.groupId}`,
    recordId: group.groupId,
    recordKind: "finance_row",
    queue: "duplicate",
    visibleGroup: "duplicates",
    financeMethod: null,
    title: "Choose the canonical Payment Tracker row",
    explanation: "Two retained Finance workbook rows are an unresolved exact cross-tab pair.",
    financialImpactUsd: group.rows[0]?.amountUsd ?? null,
    nextAction: "choose_finance_duplicate",
    href: `/operations/b2c?tab=work&financeDuplicate=${group.groupId}`,
  }));
}
```

- [ ] **Step 4: Load Finance exact groups once in workspace overview**

Use `B2cExactDuplicateReconciliationRepository.listPendingExactDuplicateGroups()` inside the Admin-only workspace repository, map with `toAdminExactDuplicateGroups`, include the groups in `B2cWorkspaceOverview`, and prepend their work items. The same loaded safe model drives both the queue and drawer; do not issue one lookup per group.

Make the repository list method page deterministically by `id`, requesting `.range(start, start + 499)` until a page contains fewer than 500 rows. Accumulate every page or throw the existing safe repository error if any page fails. Add a repository/API regression with 501 groups proving the second page is requested and no group is dropped.

- [ ] **Step 5: Add a group-specific repository read**

Add:

```ts
getPendingExactDuplicateGroup(groupId: string): Promise<ExactDuplicateGroupRow | null>
```

using `.eq("id", groupId).eq("reconciliation_state", "exact_duplicate_candidate").maybeSingle()`. Extend `GET /api/admin/b2c/reconciliation/exact-duplicates` with an optional strict UUID `groupId` query parameter: when present it calls this method and returns `{ groups: group ? toAdminExactDuplicateGroups([group]) : [] }`; without it, it calls the paged list method. Reject an invalid UUID with 422 before repository access. This supports direct deep links without loading unrelated groups.

- [ ] **Step 6: Route the workspace by explicit query parameter**

Read `financeDuplicateParam = searchParams.get("financeDuplicate")`. When present, find the matching `financeDuplicateGroups` item and set drawer target `{ kind: "financeDuplicate"; group }`. Clear `financeDuplicate` when the drawer closes. A `record` parameter continues to open payment rows only.

- [ ] **Step 7: Verify workspace tests**

Run:

```bash
npx vitest run tests/b2c-work-items.test.ts tests/b2c-workspace-api.test.ts \
  tests/b2c-workspace-ui.test.tsx tests/b2c-exact-duplicate-reconciliation-api.test.ts
```

Expected: PASS, including a regression proving a payment duplicate never opens the Finance exact-pair component.

- [ ] **Step 8: Request review and commit Task 4**

Review queue counts, deep links, large-group reads, and Viewer non-disclosure. Then:

```bash
git add src/server/services/b2c-work-items.ts src/server/repositories/b2c-workspace-repository.ts \
  src/server/repositories/b2c-exact-duplicate-reconciliation-repository.ts \
  src/server/services/b2c-exact-duplicate-review.ts \
  src/app/api/admin/b2c/reconciliation/exact-duplicates/route.ts \
  src/features/b2c/b2c-workspace.tsx tests/b2c-work-items.test.ts \
  tests/b2c-workspace-api.test.ts tests/b2c-workspace-ui.test.tsx \
  tests/b2c-exact-duplicate-reconciliation-api.test.ts
git commit -m "fix(b2c): separate payment and Finance duplicate work items"
```

---

### Task 5: Payment duplicate drawer workflow

**Files:**
- Create: `src/features/b2c/b2c-payment-duplicate-review.tsx`
- Modify: `src/features/b2c/b2c-payment-review-drawer.tsx`
- Modify: `src/features/b2c/b2c-exact-duplicate-review.tsx`
- Modify: `src/features/b2c/b2c-workspace.tsx`
- Create: `tests/b2c-payment-duplicate-routing.test.tsx`
- Modify: `tests/b2c-payment-duplicate-drawer.test.tsx`
- Modify: `tests/b2c-payment-review-drawer.test.tsx`
- Modify: `tests/b2c-workspace-ui.test.tsx`

**Interfaces:**
- Consumes: Task 3 payment group API/model and Task 4 explicit drawer targets.
- Produces: `B2cPaymentDuplicateReview({ paymentId, onSaved })`, where `onSaved(resolvedPaymentIds)` identifies every resolved payment Work item; an ungrouped legacy flag ID comes only from the protected Task 3 GET response.
- Produces: `B2cExactDuplicateReview({ group, onGroupsChanged })`, where `onGroupsChanged(groupId)` identifies the resolved Finance Work item; the fragment is group-specific and fetch-free when workspace data is present.

- [ ] **Step 1: Write the failing routing tests**

Create `tests/b2c-payment-duplicate-routing.test.tsx`. Render a manual-bank-transfer payment with `blockingReasons: ["possible_duplicate"]` and assert:

```ts
expect(await screen.findByText("Payment duplicate review")).toBeInTheDocument();
expect(screen.queryByText("Exact Finance duplicate review")).not.toBeInTheDocument();
expect(fetchMock).toHaveBeenCalledWith(
  "/api/admin/b2c/payments/payment-dup-1/duplicate-group",
  { cache: "no-store" },
);
```

Render `{ kind: "financeDuplicate", group }` and assert the inverse. Add Viewer assertions proving neither decision request is sent.

- [ ] **Step 2: Run routing tests and confirm RED**

Run:

```bash
npx vitest run tests/b2c-payment-duplicate-routing.test.tsx
```

Expected: FAIL because payment duplicates still render `B2cExactDuplicateReview`.

- [ ] **Step 3: Build the payment-group fragment**

The fragment loads the group from Task 3 and displays every member's provider reference plus retained source and effective comparison values. Label any source/effective difference explicitly; never make an override look like provider data. It manages:

```ts
const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
const [reason, setReason] = useState("");
const [saving, setSaving] = useState<"keep_all" | "keep_one" | null>(null);
```

POST keep-all as:

```ts
{
  decision: "keep_all",
  canonicalPaymentId: null,
  reason: reason.trim(),
}
```

POST keep-one with the selected member ID. Disable both buttons until the reason is meaningful; disable keep-one until a member is selected. On success validate the response `{ groupId, resolvedPaymentIds }`, then call `onSaved(resolvedPaymentIds)`; on failure retain the drawer and show a safe alert. State clearly that source/provider data remains unchanged.

If GET returns no group but the row still has an open possible-duplicate flag, show “Candidate unavailable” and the guarded stale-dismiss action. Do not offer stale dismissal when a group was returned. After stale dismissal succeeds, call `onSaved([paymentId])` so that one legacy Work item leaves the queue.

- [ ] **Step 4: Make Finance review group-specific**

Change `B2cExactDuplicateReview` to render only the supplied `AdminExactDuplicateGroup`. Remove its internal all-groups fetch and array state. After a successful decision call `onGroupsChanged(group.groupId)`; do not let one drawer display unrelated groups.

- [ ] **Step 5: Route actions in the shared drawer**

Replace `choose_duplicate` with `choose_payment_duplicate` in `REASON_TO_ACTION`. Render `B2cPaymentDuplicateReview` only for a Payment row with that action. Add the `financeDuplicate` target variant and render the group-specific `B2cExactDuplicateReview` only for that target.

Keep `ViewerReadOnlyNote` outside both Admin fragments. Wire the workspace callbacks exactly:

- payment success removes every item whose `recordId` is in `resolvedPaymentIds`;
- Finance success removes the item whose `recordId === groupId`;
- both paths recompute `counts` with `summarizeB2cWorkItemCounts`, close the drawer only after the local update, and start `void reload()` in the background.

Add a UI regression for each path proving the resolved item disappears immediately and the background reload is requested.

- [ ] **Step 6: Verify focused UI tests**

Run:

```bash
npx vitest run tests/b2c-payment-duplicate-routing.test.tsx \
  tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-payment-review-drawer.test.tsx \
  tests/b2c-workspace-ui.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Request review and commit Task 5**

Review Admin/Viewer boundaries, reason validation, group specificity, stale errors, source immutability copy, and post-save queue refresh. Then:

```bash
git add src/features/b2c/b2c-payment-duplicate-review.tsx \
  src/features/b2c/b2c-payment-review-drawer.tsx \
  src/features/b2c/b2c-exact-duplicate-review.tsx \
  src/features/b2c/b2c-workspace.tsx \
  tests/b2c-payment-duplicate-routing.test.tsx \
  tests/b2c-payment-duplicate-drawer.test.tsx tests/b2c-payment-review-drawer.test.tsx \
  tests/b2c-workspace-ui.test.tsx
git commit -m "feat(b2c): resolve payment duplicate groups from the drawer"
```

---

### Task 6: Remove split duplicate detection and document the boundary

**Files:**
- Modify: `src/server/repositories/stripe-sync-repository.ts`
- Modify: `tests/stripe-integration.test.ts`
- Modify: `tests/tap-integration.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATABASE_RULES.md`
- Modify: `docs/superpowers/plans/2026-08-20-b2c-audit-remediation.md`

**Interfaces:**
- Consumes: Task 1 automatic payment/override triggers.
- Produces: one SQL-authoritative duplicate constructor; provider repositories no longer query and flag content duplicates independently.

- [ ] **Step 1: Write failing provider-boundary tests**

Update Stripe/Tap repository tests so persisting a succeeded payment does not perform a client-side duplicate-candidate query or direct `possible_duplicate` flag upsert. Continue asserting the payment write occurs and any database error is propagated.

Add a structural assertion:

```ts
const repositorySource = readFileSync(
  path.join(process.cwd(), "src/server/repositories/stripe-sync-repository.ts"),
  "utf8",
);

expect(repositorySource).not.toContain("findRecentContentDuplicates");
expect(repositorySource).not.toContain("[payment.id, ...duplicatePaymentIds]");
```

Add `readFileSync` from `node:fs` and `path` from `node:path` to the test imports.

- [ ] **Step 2: Run provider tests and confirm RED**

Run:

```bash
npx vitest run tests/stripe-integration.test.ts tests/tap-integration.test.ts
```

Expected: FAIL because the repository still performs client-side content duplicate detection.

- [ ] **Step 3: Remove the redundant provider detector**

Delete `findRecentContentDuplicates` and the succeeded-payment duplicate block from `SupabaseB2cProviderSyncRepository`. Keep provider transaction-ID idempotency, missing-data flags, mapping flags, failed flags, and FX flags unchanged. The Task 1 database trigger now opens the group and all duplicate flags in the same transaction as the payment write.

- [ ] **Step 4: Update architecture and database rules**

Document:

- SQL-authoritative B2C content candidate construction;
- immutable group/member history;
- `keep_all`/`keep_one` semantics;
- exclusion precedence;
- separate Finance reconciliation groups;
- guarded historical backfill and stale orphan dismissal;
- Admin-only membership and RPC writes.

Mark Task 7/D7 completed in `2026-08-20-b2c-audit-remediation.md` and list `20260820111000_b2c_payment_duplicate_groups.sql` in its migration order.

- [ ] **Step 5: Run provider and documentation tests**

Run:

```bash
npx vitest run tests/stripe-integration.test.ts tests/tap-integration.test.ts tests/database-foundation.test.ts
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Request review and commit Task 6**

Review that provider ID idempotency remains intact and only content grouping moved. Then:

```bash
git add src/server/repositories/stripe-sync-repository.ts tests/stripe-integration.test.ts \
  tests/tap-integration.test.ts docs/ARCHITECTURE.md docs/DATABASE_RULES.md \
  docs/superpowers/plans/2026-08-20-b2c-audit-remediation.md
git commit -m "refactor(b2c): centralize payment duplicate detection in SQL"
```

---

### Task 7: Full verification, deployment handoff, and push

**Files:**
- Modify only if verification exposes an in-scope defect.

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: verified commits and manual migration instructions for `20260820111000_b2c_payment_duplicate_groups.sql`.

- [ ] **Step 1: Run clean database verification**

Run:

```bash
npm run supabase:reset
npm run supabase:test
```

Expected: every migration applies in timestamp order and all pgTAP assertions pass.

- [ ] **Step 2: Run complete application verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Audit generated and sensitive files**

Run:

```bash
git status --short
git diff --name-only
git diff --cached --name-only
```

Verify no `.env*`, `supabase/.temp/**`, `supabase/.branches/**`, `.worktrees/**`, raw provider exports, source workbooks, or `tsconfig.tsbuildinfo` are staged.

- [ ] **Step 4: Request final independent review**

Review the complete Task 7 range for financial correctness, database concurrency, RLS, backfill safety, request payload disclosure, queue routing, and 20,000-row scale. Resolve every blocking/important finding and rerun affected verification.

- [ ] **Step 5: Provide the manual migration command**

Tell the user to apply the migration immediately after `20260820110000_b2c_provider_evidence_mismatches.sql`:

```bash
pbcopy < supabase/migrations/20260820111000_b2c_payment_duplicate_groups.sql
```

They paste it into Supabase SQL Editor and run it once. Do not run a remote Supabase database command.

Tell them to copy the `Ungrouped open B2C possible_duplicate flags retained for manual review: N` notice from the SQL Editor result. If the UI hides notices, provide this read-only follow-up query:

```sql
select count(*) as ungrouped_open_possible_duplicate_flags
from public.review_flags flag
where flag.source_area = 'b2c_payment'
  and flag.flag_type = 'possible_duplicate'
  and flag.status = 'open'
  and not exists (
    select 1
    from public.b2c_payment_duplicate_group_members member
    join public.b2c_payment_duplicate_groups duplicate_group on duplicate_group.id = member.group_id
    where member.payment_id = flag.source_record_id
      and duplicate_group.status = 'open'
  );
```

- [ ] **Step 6: Push only after explicit payload approval**

After confirming the exact commit range and remote branch:

```bash
git push origin b2c-single-control-flow
```

Report the pushed commit hashes, verification results, migration order, and any deliberately ungrouped historical flag count returned by the production migration check.
