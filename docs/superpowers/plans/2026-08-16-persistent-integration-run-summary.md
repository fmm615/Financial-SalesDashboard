# Persistent Integration Run Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the latest saved Stripe, Tap, and HubSpot historical-backfill totals visible in Administration after a page refresh.

**Architecture:** A protected `GET /api/admin/integrations/backfill-status` endpoint will read the most recent persisted `historical_backfill` row per provider. A small client component fetches and renders the safe summary. The existing three backfill controls notify their common parent when a run settles, causing the summary to refresh from the persisted database row.

**Tech Stack:** Next.js App Router, React, TypeScript, Supabase, Vitest, Testing Library.

## Global Constraints

- Query only local `integration_sync_runs`; never call, restart, or mutate Stripe, Tap, or HubSpot.
- Require authenticated Admin access on the server before returning a summary.
- Return only provider, status, processed/failed totals, timestamps, and `safe_error_summary`.
- Treat no saved run as `not_started`, not as zero processed or a successful import.
- Do not add a migration: `integration_sync_runs` already persists the required fields.

---

### Task 1: Define and retrieve safe latest backfill summaries

**Files:**
- Create: `src/server/repositories/integration-run-summary-repository.ts`
- Create: `tests/integration-run-summary-repository.test.ts`

**Interfaces:**
- Consumes: a `DatabaseClient` with `integration_sync_runs` access.
- Produces: `IntegrationBackfillSummary` and `IntegrationRunSummaryRepository.listLatestHistoricalBackfills()`.

- [ ] **Step 1: Write the failing repository test**

```ts
const rows = await new IntegrationRunSummaryRepository(client).listLatestHistoricalBackfills();

expect(rows).toEqual([
  { provider: "stripe", status: "completed", totalProcessed: 230, totalFailed: 0, completedAt: "2026-08-16T12:00:00.000Z", safeErrorSummary: null },
  { provider: "tap", status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null },
  { provider: "hubspot", status: "failed", totalProcessed: 51, totalFailed: 2, completedAt: null, safeErrorSummary: "Safe source error." },
]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration-run-summary-repository.test.ts`

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement the typed repository**

```ts
export type IntegrationProvider = "stripe" | "tap" | "hubspot";
export type IntegrationBackfillSummary = {
  provider: IntegrationProvider;
  status: "not_started" | "processing" | "completed" | "failed";
  totalProcessed: number | null;
  totalFailed: number | null;
  completedAt: string | null;
  safeErrorSummary: string | null;
};

export class IntegrationRunSummaryRepository {
  constructor(private readonly client: DatabaseClient) {}

  async listLatestHistoricalBackfills(): Promise<IntegrationBackfillSummary[]> {
    const providers: IntegrationProvider[] = ["stripe", "tap", "hubspot"];
    const { data, error } = await this.client.from("integration_sync_runs")
      .select("provider,status,records_processed,records_failed,completed_at,safe_error_summary")
      .eq("operation_type", "historical_backfill")
      .in("provider", providers)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load saved integration runs: ${error.message}`);
    return providers.map((provider) => {
      const row = data.find((candidate) => candidate.provider === provider);
      return row ? {
        provider,
        status: row.status,
        totalProcessed: row.records_processed,
        totalFailed: row.records_failed,
        completedAt: row.completed_at,
        safeErrorSummary: row.safe_error_summary,
      } : { provider, status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null };
    });
  }
}
```

Select only `provider,status,records_processed,records_failed,completed_at,safe_error_summary`, order by `created_at` descending, and map rows locally so exactly one result is returned for Stripe, Tap, and HubSpot.

- [ ] **Step 4: Run the repository test to verify it passes**

Run: `npm test -- tests/integration-run-summary-repository.test.ts`

Expected: PASS, including the no-run state and safe persisted error mapping.

- [ ] **Step 5: Commit the repository deliverable**

```bash
git add src/server/repositories/integration-run-summary-repository.ts tests/integration-run-summary-repository.test.ts
git commit -m "feat(admin): read saved integration backfill summaries"
```

### Task 2: Expose summaries through an Admin-only read endpoint

**Files:**
- Create: `src/app/api/admin/integrations/backfill-status/route.ts`
- Create: `tests/admin-integration-backfill-status-api.test.ts`

**Interfaces:**
- Consumes: `IntegrationRunSummaryRepository.listLatestHistoricalBackfills()`.
- Produces: `GET /api/admin/integrations/backfill-status` returning `{ summaries: IntegrationBackfillSummary[] }`.

- [ ] **Step 1: Write the failing route tests**

```ts
expect(await GET(request)).toMatchObject({ status: 403 });
expect(await GET(request)).toMatchObject({
  status: 200,
  body: { summaries: [{ provider: "stripe", status: "completed", totalProcessed: 230 }] },
});
expect(await GET(request)).toMatchObject({
  status: 500,
  body: { error: "Could not load saved integration run summaries." },
});
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `npm test -- tests/admin-integration-backfill-status-api.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the protected route**

```ts
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    return NextResponse.json({ summaries: await new IntegrationRunSummaryRepository(client).listLatestHistoricalBackfills() });
  } catch {
    return NextResponse.json({ error: "Could not load saved integration run summaries." }, { status: 500 });
  }
}
```

Do not insert audit rows for this read-only status request.

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `npm test -- tests/admin-integration-backfill-status-api.test.ts`

Expected: PASS for Admin, non-Admin, and repository-error paths.

- [ ] **Step 5: Commit the endpoint deliverable**

```bash
git add src/app/api/admin/integrations/backfill-status/route.ts tests/admin-integration-backfill-status-api.test.ts
git commit -m "feat(admin): expose saved integration run status"
```

### Task 3: Render and refresh the persistent Administration summary

**Files:**
- Create: `src/features/admin/integration-run-summary.tsx`
- Modify: `src/features/admin/admin-page.tsx`
- Modify: `src/features/admin/stripe-backfill-control.tsx`
- Modify: `src/features/admin/tap-backfill-control.tsx`
- Modify: `src/features/admin/hubspot-backfill-control.tsx`
- Create: `tests/integration-run-summary-ui.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/integrations/backfill-status` and a numeric `refreshToken` prop.
- Produces: `IntegrationRunSummary({ refreshToken }: { refreshToken: number })` and optional `{ onRunSettled?: () => void }` props on the three backfill controls.

- [ ] **Step 1: Write the failing UI tests**

```tsx
render(<IntegrationRunSummary refreshToken={0} />);
expect(await screen.findByText("Stripe")).toBeInTheDocument();
expect(screen.getByText("230 processed")).toBeInTheDocument();
expect(screen.getByText("Not started")).toBeInTheDocument();

rerender(<IntegrationRunSummary refreshToken={1} />);
await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

expect(await screen.findByText("Saved run history could not be loaded.")).toBeInTheDocument();
```

Also test that a settled Stripe, Tap, or HubSpot control calls `onRunSettled` once after its completed response sequence.

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `npm test -- tests/integration-run-summary-ui.test.tsx`

Expected: FAIL because the summary component and callbacks do not exist.

- [ ] **Step 3: Implement the read-only summary and refresh wiring**

```tsx
export function IntegrationRunSummary({ refreshToken }: { refreshToken: number }) {
  const [state, setState] = useState<{ summaries: IntegrationBackfillSummary[]; error: string | null }>({ summaries: [], error: null });
  useEffect(() => {
    let active = true;
    void fetch("/api/admin/integrations/backfill-status")
      .then(async (response) => response.ok ? response.json() : Promise.reject())
      .then((body) => { if (active) setState({ summaries: body.summaries, error: null }); })
      .catch(() => { if (active) setState({ summaries: [], error: "Saved run history could not be loaded." }); });
    return () => { active = false; };
  }, [refreshToken]);
  if (state.error) return <p role="alert">{state.error}</p>;
  return <section aria-label="Saved integration runs">
    {state.summaries.map((summary) => <article key={summary.provider}>
      <h3>{summary.provider}</h3><p>{summary.status}</p>
      <p>{summary.totalProcessed === null ? "No historical backfill has run." : `${summary.totalProcessed} processed`}</p>
      {summary.totalFailed !== null && <p>{summary.totalFailed} flagged</p>}
      {summary.completedAt && <time dateTime={summary.completedAt}>{summary.completedAt}</time>}
      {summary.safeErrorSummary && <p role="alert">{summary.safeErrorSummary}</p>}
    </article>)}
  </section>;
}
```

In `AdminPage`, store `const [backfillRefreshToken, setBackfillRefreshToken] = useState(0);`, render the summary above the controls, and pass `onRunSettled={() => setBackfillRefreshToken((value) => value + 1)}` to the three controls. Each control calls the callback once in `finally`, after its provider import has settled. Keep its existing transient progress message unchanged.

- [ ] **Step 4: Run the UI tests to verify they pass**

Run: `npm test -- tests/integration-run-summary-ui.test.tsx`

Expected: PASS for saved totals, no-run state, error state, refresh token, and control callback behavior.

- [ ] **Step 5: Commit the UI deliverable**

```bash
git add src/features/admin/integration-run-summary.tsx src/features/admin/admin-page.tsx src/features/admin/stripe-backfill-control.tsx src/features/admin/tap-backfill-control.tsx src/features/admin/hubspot-backfill-control.tsx tests/integration-run-summary-ui.test.tsx
git commit -m "feat(admin): retain integration results after reload"
```

### Task 4: Verify the complete feature and update operational documentation

**Files:**
- Modify: `docs/INTEGRATIONS.md`

**Interfaces:**
- Consumes: the completed Admin status endpoint and summary component.
- Produces: operator instructions that distinguish reviewing saved totals from restarting a backfill.

- [ ] **Step 1: Add the operational instruction**

Document that Integration Status displays the latest persisted historical-backfill total after reload, that the values are audit records rather than financial totals, and that an operator should not restart a provider solely to view prior counts.

- [ ] **Step 2: Run focused and full verification**

Run: `npm test -- tests/integration-run-summary-repository.test.ts tests/admin-integration-backfill-status-api.test.ts tests/integration-run-summary-ui.test.tsx`

Expected: PASS.

Run: `npm run typecheck && npm run lint && npm test && npm run build && git diff --check`

Expected: every command exits successfully.

- [ ] **Step 3: Commit the verified documentation update**

```bash
git add docs/INTEGRATIONS.md
git commit -m "docs(admin): explain saved integration status"
```
