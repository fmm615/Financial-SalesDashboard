# Live Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock Review Queue with a real, audited review hub without allowing unfinished B2B/B2C data rules to affect financial results.

**Architecture:** A focused repository reads existing review flags and history through the request-scoped Supabase client. A pure service maps those rows to queue domain objects with safe source references and source-specific next actions; thin routes validate query/body input and keep all writes Admin-only. The client page fetches those routes and presents loading, empty, error, history, and role-aware note states.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Supabase PostgreSQL/RLS, Zod, React, Tailwind CSS.

## Global Constraints

- B2B and B2C source data and financial decisions are not final: do not calculate, display, infer, or write financial values in this work.
- Missing data is not zero; an empty queue means no visible flags, not no financial activity.
- Never delete a flag, source record, note, resolution, refund, booking, receipt, or recognised-sale record.
- A B2C `possible_duplicate` must remain excluded until a future dedicated, audited keep/exclude decision is designed; a generic flag resolution must reject it.
- Use the request-scoped authenticated Supabase client for all user actions. RLS and audit triggers are the authorization authority; service-role access is prohibited.
- Viewer access is read-only. Admin notes require meaningful text, Zod validation, and database actor attribution.
- Keep API routes thin, preserve provider read-only boundaries, add tests before implementation, and make one focused commit per completed task.

---

## File Structure

- Create: `supabase/migrations/20260810120000_review_queue_duplicate_safety.sql` — restricts the generic B2C resolution RPC from closing possible duplicates.
- Modify: `src/types/database.generated.ts` — records the updated RPC contract comments/types if generation changes it.
- Modify: `tests/database-foundation.test.ts` — checks the migration’s safety condition.
- Create: `src/lib/validation/review-queue-contracts.ts` — query and note schemas, plus inferred inputs.
- Create: `src/server/repositories/review-queue-repository.ts` — RLS-respecting database reads and Admin note insert.
- Create: `src/server/services/review-queue.ts` — pure database-to-UI mapping, filtering, counts, source actions, and detail assembly.
- Create: `src/app/api/review-queue/route.ts` — validated list endpoint.
- Create: `src/app/api/review-queue/[flagId]/route.ts` — validated detail endpoint.
- Create: `src/app/api/review-queue/[flagId]/notes/route.ts` — Admin-only note endpoint.
- Create: `tests/review-queue-contracts.test.ts` — validation and mapping regression tests.
- Create: `tests/review-queue-api.test.ts` — route authorization/validation tests with mocked request-scoped clients.
- Modify: `src/features/review-queue/review-queue-page.tsx` — replaces mock data and local status mutation with live fetching, filters, and data states.
- Modify: `src/components/review-ui.tsx` — renders live detail/history/note controls and source-aware next actions.
- Modify: `tests/ui-system.test.tsx` and `tests/auth-ui.test.tsx` — replace mock-only queue tests with live payload and role-safe tests.
- Modify: `docs/ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, and `docs/TESTING_STRATEGY.md` — document the boundary, data model, and safeguards.

## Task 1: Protect B2C possible duplicates at the database boundary

**Files:**

- Create: `supabase/migrations/20260810120000_review_queue_duplicate_safety.sql`
- Modify: `tests/database-foundation.test.ts`
- Modify: `src/types/database.generated.ts` only if `npm run supabase:types` changes the checked-in snapshot after the migration is applied locally.

**Interfaces:**

- Replaces `public.resolve_b2c_review_flag(uuid, review_flag_status, text)` with the same signature.
- Produces a database error for a flag whose `flag_type = 'possible_duplicate'`; all other existing source-specific resolution flows remain unchanged.

- [ ] **Step 1: Read the test-writing guidance and write the failing database contract test**

Read `superpowers:test-driven-development` and its required `writing-good-tests.md` reference. Add this assertion to `tests/database-foundation.test.ts`:

```ts
const reviewQueueSafety = migration("20260810120000_review_queue_duplicate_safety.sql");

expect(reviewQueueSafety).toContain("flag_type = 'possible_duplicate'");
expect(reviewQueueSafety).toContain("must be decided through the dedicated duplicate workflow");
expect(reviewQueueSafety).toContain("create or replace function public.resolve_b2c_review_flag");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/database-foundation.test.ts`

Expected: FAIL because the safety migration does not exist.

- [ ] **Step 3: Add the narrow safety migration**

Copy the current `resolve_b2c_review_flag` function body from `20260804140000_stripe_product_mapping_review.sql`, retaining its Admin check, resolution status validation, and open-flag check. Before inserting the resolution, load the flag and reject it when it is a B2C `possible_duplicate`:

```sql
if exists (
  select 1
  from public.review_flags
  where id = p_flag_id
    and source_area in ('b2c_payment', 'b2c_refund')
    and flag_type = 'possible_duplicate'
    and status = 'open'
) then
  raise exception 'Possible duplicates must be decided through the dedicated duplicate workflow';
end if;
```

Keep the existing revoke/grant statements. Do not add a duplicate group, an exclusion column, a financial exception, or any provider write.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- tests/database-foundation.test.ts`

Expected: PASS.

If Supabase is available locally after the user applies the migration, also run: `npm run supabase:test`.

- [ ] **Step 5: Commit the database safety slice**

```bash
git add supabase/migrations/20260810120000_review_queue_duplicate_safety.sql tests/database-foundation.test.ts
git commit -m "fix(review-queue): protect B2C duplicate exclusions"
```

If generated types changed after local generation, stage them explicitly in the
same commit with `git add src/types/database.generated.ts`.

## Task 2: Add typed live queue reads and source-aware actions

**Files:**

- Create: `src/lib/validation/review-queue-contracts.ts`
- Create: `src/server/repositories/review-queue-repository.ts`
- Create: `src/server/services/review-queue.ts`
- Create: `src/app/api/review-queue/route.ts`
- Create: `src/app/api/review-queue/[flagId]/route.ts`
- Create: `tests/review-queue-contracts.test.ts`
- Create: `tests/review-queue-api.test.ts`

**Interfaces:**

- `reviewQueueListQuerySchema` accepts `{ status?, flagType?, priority?, query? }`; default status is `open`; `query` is trimmed and at most 200 characters.
- `reviewQueueFlagIdSchema` accepts a UUID route parameter.
- `ReviewQueueRepository.listFlags()` returns only `review_flags` fields needed for the queue, ordered by priority ascending then creation descending.
- `ReviewQueueRepository.getFlagDetail(flagId)` returns one flag plus `review_flag_resolutions` and `review_notes`, both in ascending creation order.
- `toReviewQueueItem(flag)` maps a raw flag to a UI-safe queue item; `createReviewQueueService(repository)` exposes `list(input)` and `detail(flagId)` and returns no raw Supabase rows.
- `GET /api/review-queue` returns `{ items, metrics }`; `GET /api/review-queue/[flagId]` returns `{ item }` or a safe 404.

- [ ] **Step 1: Write failing domain and API tests**

Use a fake repository in `tests/review-queue-contracts.test.ts` and assert the pure mapping. The representative behaviours are:

```ts
expect(toReviewQueueItem({
  source_area: "b2c_payment", flag_type: "possible_duplicate", status: "open",
  priority: 2, reason: "Matched source records", id: FLAG_ID,
  source_record_id: PAYMENT_ID, created_at: "2026-08-10T09:00:00.000Z",
})).toMatchObject({
  sourceLabel: `B2C payment · ${PAYMENT_ID}`,
  nextAction: { kind: "note_only", label: "Duplicate decision required" },
});

expect(toReviewQueueItem({
  source_area: "b2b_deal", flag_type: "possible_duplicate", status: "open",
  priority: 2, reason: "Matched source records", id: FLAG_ID,
  source_record_id: DEAL_ID, created_at: "2026-08-10T09:00:00.000Z",
})).toMatchObject({
  nextAction: { kind: "navigate", href: "/admin", label: "Open B2B duplicate review" },
});
```

Add list-filter/count expectations: `openCount` counts open items, `resolvedThisMonthCount` counts resolved/dismissed items created in the supplied current month, and `highPriorityOpenCount` counts open priority 1–2 items. Add route tests proving an unauthenticated request receives 403, an invalid query/UUID receives 422, and a repository failure receives one safe 500 message without database detail.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts`

Expected: FAIL because the validation, repository, service, and routes do not exist.

- [ ] **Step 3: Implement contracts, repository, service, and read routes**

Use Zod enums matching existing database values:

```ts
export const reviewQueueListQuerySchema = z.object({
  status: z.enum(["open", "resolved", "dismissed", "all"]).default("open"),
  flagType: z.enum(["refunded", "failed", "possible_duplicate", "unmapped_product", "needs_follow_up"]).optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  query: z.string().trim().max(200).optional(),
}).strict();
```

The repository must use only the injected request-scoped `DatabaseClient`; it must not create a service client. Read flag fields `id`, `source_area`, `source_record_id`, `flag_type`, `status`, `priority`, `reason`, `created_at`, `resolved_at`, and `assigned_to`. Read resolution fields `resolution_status`, `resolution_note`, `created_by`, `created_at`; read note fields `id`, `note`, `created_by`, `created_at`.

Use stable action mapping in the service:

```ts
function getNextAction(sourceArea: string, flagType: string): ReviewQueueNextAction {
  if (sourceArea === "b2c_payment" && flagType === "possible_duplicate") return { kind: "note_only", label: "Duplicate decision required" };
  if (sourceArea === "b2b_deal" && flagType === "possible_duplicate") return { kind: "navigate", href: "/admin", label: "Open B2B duplicate review" };
  if (sourceArea === "b2c_payment" || sourceArea === "b2c_refund" || sourceArea === "product_mapping") return { kind: "navigate", href: "/operations/b2c", label: "Open B2C Operations" };
  if (sourceArea.startsWith("b2b_")) return { kind: "navigate", href: "/operations/b2b", label: "Open B2B Operations" };
  if (sourceArea === "integration") return { kind: "navigate", href: "/admin", label: "Open Administration" };
  return { kind: "note_only", label: "Review source details" };
}
```

The list and detail routes must check `client.auth.getUser()` and `getApprovedRole`; approved Admins and Viewers can read. Do not return raw provider payloads, money, or technical error content.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the live read slice**

```bash
git add src/lib/validation/review-queue-contracts.ts src/server/repositories/review-queue-repository.ts src/server/services/review-queue.ts src/app/api/review-queue/route.ts 'src/app/api/review-queue/[flagId]/route.ts' tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts
git commit -m "feat(review-queue): add live review reads"
```

## Task 3: Add append-only Admin review notes

**Files:**

- Modify: `src/lib/validation/review-queue-contracts.ts`
- Modify: `src/server/repositories/review-queue-repository.ts`
- Create: `src/app/api/review-queue/[flagId]/notes/route.ts`
- Modify: `tests/review-queue-contracts.test.ts`
- Modify: `tests/review-queue-api.test.ts`

**Interfaces:**

- `reviewQueueNoteSchema` accepts `{ note: string }` with trimmed meaningful text from 3 to 1000 characters; a dash or `N/A` is rejected.
- `ReviewQueueRepository.addNote(flagId, note)` first confirms the flag exists and then inserts only `{ flag_id, note }`; the database trigger supplies `created_by`.
- `POST /api/review-queue/[flagId]/notes` returns `{ ok: true }`, 403 for non-Admins, 422 for bad input/UUID, and 404 if the flag is not visible/available.

- [ ] **Step 1: Write failing note validation and route tests**

Add representative tests:

```ts
expect(reviewQueueNoteSchema.safeParse({ note: "  -  " }).success).toBe(false);
expect(reviewQueueNoteSchema.safeParse({ note: "Verified source reference with Finance" }).success).toBe(true);

expect(repository.addNote).toHaveBeenCalledWith(FLAG_ID, "Verified source reference with Finance");
expect(response.status).toBe(403); // Viewer POST attempt
```

Also assert that the route never accepts `created_by`, `status`, or a resolution value from the browser.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts`

Expected: FAIL because note validation, repository insert, and route do not exist.

- [ ] **Step 3: Implement the Admin note boundary**

Implement the schema with `.strict()` and a placeholder refinement. The route obtains the current user and requires `getApprovedRole(...) === "admin"` before parsing/using the body. The repository inserts only:

```ts
await this.client.from("review_notes").insert({ flag_id: flagId, note });
```

Do not insert `created_by`, update `review_flags`, create a resolution, or mutate the source record. Return a generic save error if Supabase rejects the write.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the audited note slice**

```bash
git add src/lib/validation/review-queue-contracts.ts src/server/repositories/review-queue-repository.ts 'src/app/api/review-queue/[flagId]/notes/route.ts' tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts
git commit -m "feat(review-queue): add audited review notes"
```

## Task 4: Replace the mock UI and document the live boundary

**Files:**

- Modify: `src/features/review-queue/review-queue-page.tsx`
- Modify: `src/components/review-ui.tsx`
- Modify: `tests/ui-system.test.tsx`
- Modify: `tests/auth-ui.test.tsx`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATABASE_SCHEMA.md`
- Modify: `docs/TESTING_STRATEGY.md`

**Interfaces:**

- The page fetches `GET /api/review-queue` and `GET /api/review-queue/:flagId`; it no longer imports `@/mocks/review-queue` or writes client-only resolution state.
- `DetailDrawer` consumes `ReviewQueueDetail`, renders note/resolution history, and takes `onAddNote(note): Promise<void>` only for an Admin.
- Queue list data states are `loading`, `empty`, `error`, and `ready`; no state presents mock records or financial zero values.

- [ ] **Step 1: Write failing UI tests**

Replace the existing mock-specific tests with controlled `fetch` fixtures. Cover:

```ts
expect(screen.getByText("Loading review queue")).toBeInTheDocument();

await screen.findByText("B2C payment · 11111111-1111-4111-8111-111111111111");
fireEvent.click(screen.getByText("Possible duplicate"));
expect(await screen.findByText("Duplicate decision required")).toBeInTheDocument();
expect(screen.queryByRole("button", { name: "Mark as reviewed" })).not.toBeInTheDocument();

render(<RoleProvider role="viewer"><ReviewQueuePage /></RoleProvider>);
expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
```

Also test an Admin note submission refreshes the displayed detail after a successful response and leaves the drawer open with an error message after a failed response.

- [ ] **Step 2: Run the focused UI tests and verify they fail**

Run: `npm test -- tests/ui-system.test.tsx tests/auth-ui.test.tsx`

Expected: FAIL because the page still imports mock data and exposes the local-only review action.

- [ ] **Step 3: Implement the live presentation layer**

Keep the existing AppShell/table styling, but:

1. replace `reviewItems` and `statusById` with fetched domain data;
2. make the search/status/type/priority controls update the query and refetch;
3. derive the three metric cards from `{ metrics }` returned by the list route;
4. use `LoadingSkeleton`, `EmptyState`, and `ErrorState` for honest states;
5. fetch a full detail when an item opens; render its notes and resolution history chronologically;
6. show the service-provided next-action link; B2C duplicates show note-only guidance;
7. give Admins a controlled note form that posts `{ note }` to the note route and refreshes data only after `{ ok: true }`;
8. remove the mock textarea and `Mark as reviewed` button completely.

Never optimistically mark an item resolved. Do not use a client role check as authorization; it only controls presentation after the server/RLS boundary has already enforced writes.

- [ ] **Step 4: Update documentation and run focused verification**

Document that the queue is backed by retained review tables, Admin notes are append-only and audited, generic B2C duplicate resolution is blocked, and B2C duplicate decisions remain deferred pending final rules.

Run: `npm test -- tests/ui-system.test.tsx tests/auth-ui.test.tsx tests/review-queue-contracts.test.ts tests/review-queue-api.test.ts tests/database-foundation.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the completion checks and commit the UI slice**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

Expected: every command exits 0.

```bash
git add src/features/review-queue/review-queue-page.tsx src/components/review-ui.tsx tests/ui-system.test.tsx tests/auth-ui.test.tsx docs/ARCHITECTURE.md docs/DATABASE_SCHEMA.md docs/TESTING_STRATEGY.md
git commit -m "feat(review-queue): make the review queue live"
```

## Manual Supabase sequence

Before testing against a real Supabase project, apply the migration in this order:

1. `supabase/migrations/20260810120000_review_queue_duplicate_safety.sql`

Then regenerate `src/types/database.generated.ts` with `npm run supabase:types` against the target schema if Supabase reports a generated-type change. No other queue migration should be applied by hand for this plan.
