import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { decorateB2cLedgerRow, SupabaseB2cLedgerRepository, type B2cDecoratedLedgerRow, type B2cLedgerFilterMetadata, type B2cLedgerQuery } from "@/server/repositories/b2c-ledger-repository";
import { getB2cDashboardSnapshot, getB2cDashboardSummary } from "@/server/repositories/b2c-dashboard-repository";
import type { DatabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.generated";
import { buildB2cLedgerEquivalenceFixture } from "../tests/fixtures/b2c-ledger-equivalence";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TODAY = new Date("2026-09-16T00:00:00.000Z");

type Mode = "legacy" | "keyset" | "equivalence";
type LocalEnvironment = { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string; JWT_SECRET: string };

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Performance-runner counts must be positive integers.");
  return parsed;
}

function readLocalEnvironment(): LocalEnvironment {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.split("\n").flatMap((line) => {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
  for (const key of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "JWT_SECRET"] as const) {
    if (!values[key]) throw new Error(`Local Supabase did not provide ${key}.`);
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(values.API_URL)) {
    throw new Error("Refusing to run the B2C performance fixture against a non-local Supabase URL.");
  }
  return values as LocalEnvironment;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function adminToken(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    aud: "authenticated",
    exp: now + 3600,
    iat: now,
    role: "authenticated",
    sub: ADMIN_ID,
  }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function clients(environment: LocalEnvironment) {
  const common = { auth: { autoRefreshToken: false, persistSession: false } };
  const service = createClient<Database>(environment.API_URL, environment.SERVICE_ROLE_KEY, common);
  const token = adminToken(environment.JWT_SECRET);
  const admin = createClient<Database>(environment.API_URL, environment.ANON_KEY, {
    ...common,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { service, admin };
}

async function insertBatches(client: SupabaseClient<Database>, table: keyof Database["public"]["Tables"], rows: Array<Record<string, unknown>>) {
  for (let start = 0; start < rows.length; start += 250) {
    const { error } = await client.from(table).insert(rows.slice(start, start + 250) as never);
    if (error) throw new Error(`Could not seed ${String(table)}: ${error.message}`);
  }
}

async function seedFixture(service: SupabaseClient<Database>, count: number) {
  const fixture = buildB2cLedgerEquivalenceFixture(count);
  await insertBatches(service, "b2c_payments", fixture.payments);
  await insertBatches(service, "b2c_refunds", fixture.refunds);
  await insertBatches(service, "b2c_payment_local_overrides", fixture.localOverrides);
  await insertBatches(service, "b2c_payment_fx_conversions", fixture.paymentFxConversions);
  await insertBatches(service, "review_flags", fixture.reviewFlags);
  await insertBatches(service, "b2c_payment_finance_exception_decisions", fixture.financeExceptionDecisions);
  await insertBatches(service, "b2c_payment_duplicate_groups", fixture.duplicateGroups);
  await insertBatches(service, "b2c_payment_duplicate_group_members", fixture.duplicateGroupMembers);
  return fixture;
}

function sourceMatches(row: B2cDecoratedLedgerRow, query: B2cLedgerQuery): boolean {
  if (query.source && row.sourceSystem !== query.source) return false;
  if (query.sourceStatus && row.decision.sourceStatus !== query.sourceStatus) return false;
  if (query.paymentStatus && row.paymentStatus !== query.paymentStatus) return false;
  if (query.reportingDecision && row.decision.reportingDecision !== query.reportingDecision) return false;
  if (query.issue === "none" ? row.issue !== null : query.issue && row.issue !== query.issue) return false;
  if (query.dateFrom && row.dateValue < query.dateFrom) return false;
  if (query.dateTo && row.dateValue > query.dateTo) return false;
  if (query.category && row.category !== query.category) return false;
  if (query.foreignCurrencyOnly && !row.foreignCurrencyReview) return false;
  if (query.currency && (row.sourceOriginalCurrency ?? "USD") !== query.currency) return false;
  const absoluteAmount = row.amountValueUsd === null ? null : Math.abs(Number(row.amountValueUsd));
  if (query.minAmountUsd && (absoluteAmount === null || absoluteAmount < Number(query.minAmountUsd))) return false;
  if (query.maxAmountUsd && (absoluteAmount === null || absoluteAmount > Number(query.maxAmountUsd))) return false;
  if (query.search) {
    const needle = query.search.trim().toLowerCase();
    const haystack = [row.customerName, row.customerEmail, row.customerPhone, row.providerReference].filter(Boolean).join(" ").toLowerCase();
    if (needle && !haystack.includes(needle)) return false;
  }
  return true;
}

function sortedRows(rows: B2cDecoratedLedgerRow[], sort: B2cLedgerQuery["sort"]): B2cDecoratedLedgerRow[] {
  const result = [...rows];
  const amount = (row: B2cDecoratedLedgerRow) => Number(row.amountValueUsd ?? "0");
  if (sort === "date_asc") result.sort((first, second) => first.dateValue.localeCompare(second.dateValue));
  else if (sort === "amount_desc") result.sort((first, second) => amount(second) - amount(first));
  else if (sort === "amount_asc") result.sort((first, second) => amount(first) - amount(second));
  else result.sort((first, second) => second.dateValue.localeCompare(first.dateValue));
  return result;
}

function legacyMetadata(rows: B2cDecoratedLedgerRow[]): B2cLedgerFilterMetadata {
  return {
    sources: [...new Set(rows.map((row) => row.source))].sort(),
    categories: [...new Set(rows.map((row) => row.category))].sort(),
    issues: [...new Set(rows.flatMap((row) => row.issue ? [row.issue] : []))].sort(),
    foreignCurrencyCount: rows.filter((row) => row.foreignCurrencyReview).length,
  };
}

async function legacyRows(client: DatabaseClient, period: string) {
  const snapshot = await getB2cDashboardSnapshot(client, TODAY, period);
  return { snapshot, rows: snapshot.rows.map((row) => decorateB2cLedgerRow(row)) };
}

async function legacyQuery(client: DatabaseClient, query: B2cLedgerQuery) {
  const { snapshot, rows } = await legacyRows(client, query.period ?? "all");
  const filtered = sortedRows(rows.filter((row) => sourceMatches(row, query)), query.sort ?? "date_desc");
  const start = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  return {
    snapshot,
    rows: filtered.slice(start, start + limit),
    allRows: filtered,
    nextCursor: start + limit < filtered.length ? String(start + limit) : null,
    totalCount: filtered.length,
    filterMetadata: legacyMetadata(rows),
  };
}

async function keysetAll(repository: SupabaseB2cLedgerRepository, query: B2cLedgerQuery) {
  const rows: B2cDecoratedLedgerRow[] = [];
  let cursor: string | undefined;
  let firstPage: Awaited<ReturnType<SupabaseB2cLedgerRepository["page"]>> | null = null;
  do {
    const page = await repository.page({ ...query, cursor, limit: 100 }, TODAY);
    firstPage ??= page;
    rows.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (!firstPage) throw new Error("The keyset repository returned no page result.");
  return { rows, firstPage };
}

function comparableRow(row: B2cDecoratedLedgerRow) {
  const value = { ...row } as Record<string, unknown>;
  delete value.stripeEvidence;
  delete value.sqlDecision;
  if (value.sourceSellerMessage === undefined) value.sourceSellerMessage = null;
  for (const field of ["amountValueUsd", "sourceOriginalAmount"] as const) {
    if (typeof value[field] === "number" || typeof value[field] === "string") {
      const [whole, fraction = ""] = String(value[field]).split(".");
      value[field] = `${whole}.${fraction.padEnd(6, "0")}`;
    }
  }
  return value;
}

function stableRows(rows: B2cDecoratedLedgerRow[]) {
  return rows.map(comparableRow).sort((first, second) => String(first.id).localeCompare(String(second.id)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const actualText = JSON.stringify(canonical(actual));
  const expectedText = JSON.stringify(canonical(expected));
  if (actualText !== expectedText) {
    if (Array.isArray(actual) && Array.isArray(expected)) {
      const index = Array.from({ length: Math.max(actual.length, expected.length) }, (_, itemIndex) => itemIndex)
        .find((itemIndex) => JSON.stringify(canonical(actual[itemIndex])) !== JSON.stringify(canonical(expected[itemIndex])));
      throw new Error(`${label} differs at row ${index}: actual=${JSON.stringify(actual[index ?? 0])} expected=${JSON.stringify(expected[index ?? 0])}`);
    }
    throw new Error(`${label} differs: actual=${actualText} expected=${expectedText}`);
  }
}

async function runEquivalence(client: DatabaseClient, repository: SupabaseB2cLedgerRepository, namedCases: ReturnType<typeof buildB2cLedgerEquivalenceFixture>["namedCases"]) {
  const scenarios: Array<{ name: string; query: B2cLedgerQuery }> = [
    { name: "august", query: { period: "2026-08", sort: "date_desc" } },
    { name: "all-time", query: { period: "all", sort: "date_desc" } },
    { name: "source-search", query: { period: "all", source: "stripe", search: "Fixture customer 12", sort: "date_asc" } },
    { name: "foreign", query: { period: "all", foreignCurrencyOnly: true, sort: "amount_asc" } },
    { name: "issue", query: { period: "all", issue: "Needs follow-up", sort: "date_desc" } },
    { name: "amount", query: { period: "all", minAmountUsd: "200", maxAmountUsd: "240", sort: "amount_desc" } },
  ];
  const results: Array<{ scenario: string; rows: number }> = [];
  for (const scenario of scenarios) {
    const legacy = await legacyQuery(client, scenario.query);
    const keyset = await keysetAll(repository, scenario.query);
    assertEqual(keyset.firstPage.totalCount, legacy.totalCount, `${scenario.name} total count`);
    assertEqual(keyset.firstPage.filterMetadata, legacy.filterMetadata, `${scenario.name} filter metadata`);
    assertEqual(stableRows(keyset.rows), stableRows(legacy.allRows), `${scenario.name} row values and decisions`);
    if (new Set(keyset.rows.map((row) => `${row.recordType}:${row.id}`)).size !== keyset.rows.length) {
      throw new Error(`${scenario.name} keyset traversal repeated an identity.`);
    }
    results.push({ scenario: scenario.name, rows: keyset.rows.length });
  }

  const august = await keysetAll(repository, { period: "2026-08", sort: "date_desc" });
  const augustIds = new Set(august.rows.map((row) => row.id));
  if (!augustIds.has(namedCases.movedIn) || augustIds.has(namedCases.movedOut)) {
    throw new Error("Effective-date override membership differs at the August boundary.");
  }

  for (const period of ["2026-08", "all"]) {
    const legacy = await getB2cDashboardSnapshot(client, TODAY, period);
    const summary = await getB2cDashboardSummary(client, TODAY, period);
    assertEqual(summary, { ...legacy, rows: [] }, `${period} dashboard aggregate`);
  }
  return results;
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timed(name: string, runs: number, operation: () => Promise<{ rows: number; count: number }>) {
  await operation();
  const durations: number[] = [];
  let result = { rows: 0, count: 0 };
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    result = await operation();
    durations.push(Number((performance.now() - started).toFixed(2)));
  }
  return { name, durationsMs: durations, medianMs: median(durations), ...result };
}

async function runLegacyTimings(client: DatabaseClient, runs: number, evidenceId: string) {
  const timings = [];
  timings.push(await timed("current-month", runs, async () => { const value = await legacyQuery(client, { period: "2026-09", limit: 100 }); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("all-time", runs, async () => { const value = await legacyQuery(client, { period: "all", limit: 100 }); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("selective-filter", runs, async () => { const value = await legacyQuery(client, { period: "all", limit: 100, search: "Fixture customer 979" }); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("next-page", runs, async () => { const value = await legacyQuery(client, { period: "all", limit: 100, cursor: "100" }); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("evidence", runs, async () => { const value = await legacyQuery(client, { period: "all", limit: 100 }); return { rows: value.allRows.some((row) => row.id === evidenceId) ? 1 : 0, count: value.totalCount }; }));
  return timings;
}

async function runKeysetTimings(client: SupabaseClient<Database>, repository: SupabaseB2cLedgerRepository, runs: number, evidenceId: string) {
  const first = await repository.page({ period: "all", limit: 100 }, TODAY);
  if (!first.nextCursor) throw new Error("The performance fixture did not produce a second page.");
  const timings = [];
  timings.push(await timed("current-month", runs, async () => { const value = await repository.page({ period: "2026-09", limit: 100 }, TODAY); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("all-time", runs, async () => { const value = await repository.page({ period: "all", limit: 100 }, TODAY); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("selective-filter", runs, async () => { const value = await repository.page({ period: "all", limit: 100, search: "Fixture customer 979" }, TODAY); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("next-page", runs, async () => { const value = await repository.page({ period: "all", limit: 100, cursor: first.nextCursor! }, TODAY); return { rows: value.rows.length, count: value.totalCount }; }));
  timings.push(await timed("evidence", runs, async () => { const value = await client.rpc("get_b2c_payment_evidence", { p_payment_id: evidenceId }); if (value.error) throw value.error; return { rows: value.data ? 1 : 0, count: value.data ? 1 : 0 }; }));
  return timings;
}

async function main() {
  const mode = (argument("mode") ?? "equivalence") as Mode;
  if (!(["legacy", "keyset", "equivalence"] as const).includes(mode)) throw new Error("Use --mode=legacy, --mode=keyset, or --mode=equivalence.");
  const runs = parsePositiveInteger(argument("runs"), 5);
  // Keep each legacy source table below PostgREST's 1,000-row response cap so
  // the intended old rules remain a usable oracle. Payments plus refunds still
  // produce a realistically large ~1,075-row ledger. The 1,250-row unit
  // fixture separately protects the new uncapped Work-decision transport.
  const count = parsePositiveInteger(argument("count"), 980);
  const reuseSeed = process.argv.includes("--reuse-seed");
  const shouldReset = !reuseSeed && !process.argv.includes("--no-reset");
  if (shouldReset) execFileSync("npx", ["supabase", "db", "reset", "--local"], { stdio: "inherit" });
  const environment = readLocalEnvironment();
  const { service, admin } = clients(environment);
  const fixture = reuseSeed ? buildB2cLedgerEquivalenceFixture(count) : await seedFixture(service, count);
  const databaseClient = admin as unknown as DatabaseClient;
  const repository = new SupabaseB2cLedgerRepository(databaseClient);

  if (mode === "equivalence") {
    const scenarios = await runEquivalence(databaseClient, repository, fixture.namedCases);
    console.log(JSON.stringify({ mode, dataset: { payments: fixture.payments.length, refunds: fixture.refunds.length }, differences: 0, scenarios }, null, 2));
    return;
  }
  const timings = mode === "legacy"
    ? await runLegacyTimings(databaseClient, runs, fixture.namedCases.foreignConverted)
    : await runKeysetTimings(admin, repository, runs, fixture.namedCases.foreignConverted);
  console.log(JSON.stringify({ mode, dataset: { payments: fixture.payments.length, refunds: fixture.refunds.length }, runs, timings }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The B2C performance runner failed.");
  process.exitCode = 1;
});
