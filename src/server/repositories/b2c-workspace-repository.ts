import type { DatabaseClient } from "@/lib/supabase/server";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";
import { decorateB2cLedgerRow, type B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";
import { getB2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";
import { summarizeFinancePostingReadiness } from "@/server/services/b2c-finance-action-center";
import {
  buildB2cPendingCandidateWorkItems,
  buildB2cWorkItems,
  type B2cPendingCandidateRecord,
  type B2cSourceFailureRecord,
  type B2cWorkItem,
  type B2cWorkItemRecord,
} from "@/server/services/b2c-work-items";

export type B2cWorkspaceCounts = { all: number; data: number; duplicates: number; reconciliation: number; ready_to_post: number };

export type B2cWorkspaceOverview = {
  items: B2cWorkItem[];
  counts: B2cWorkspaceCounts;
  pendingCandidates?: B2cPendingCandidateRecord[];
};

/** Summarizes the internally detailed work items into the five visible Work queue filter counts. */
export function summarizeB2cWorkItemCounts(items: B2cWorkItem[]): B2cWorkspaceCounts {
  const counts: B2cWorkspaceCounts = { all: items.length, data: 0, duplicates: 0, reconciliation: 0, ready_to_post: 0 };
  for (const item of items) counts[item.visibleGroup] += 1;
  return counts;
}

const READY_TO_POST_HREF = "/operations/b2c?tab=work&queue=ready_to_post";
const WORKSPACE_QUERY_VALUE_BATCH_SIZE = 100;
const WORKSPACE_QUERY_CONCURRENCY = 4;

/** Splits a large PostgREST `in` filter into URL-safe groups without dropping any value. */
export function chunkB2cWorkspaceQueryValues<T>(values: T[], size = WORKSPACE_QUERY_VALUE_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) batches.push(values.slice(start, start + size));
  return batches;
}

/** Maps one decorated ledger row into the record shape the pure work-item builder expects. */
export function toB2cWorkItemRecord(row: B2cDecoratedLedgerRow): B2cWorkItemRecord {
  const financeMethod = row.source === "Finance — iOS" ? "ios" : row.source === "Finance — Bank transfer" ? "bank_transfer" : null;
  const recordKind: B2cWorkItemRecord["recordKind"] = row.recordType === "Refund"
    ? "provider_refund"
    : row.recordType === "Tap statement sale"
      ? "provider_evidence"
      : row.sourceSystem === "finance_tracker"
        ? "finance_row"
        : "provider_payment";
  return {
    id: row.id,
    recordKind,
    decision: row.decision,
    financeMethod,
    customerLabel: row.customerName ?? row.customerEmail ?? "this record",
    financialImpactUsd: row.amountValueUsd,
    href: `/operations/b2c?tab=work&record=${row.id}`,
  };
}

/** Aggregates every already-decorated ledger row plus source-failure runs into the one Work queue overview. */
export function buildB2cWorkspaceOverview(input: {
  ledgerRows: B2cDecoratedLedgerRow[];
  sourceFailures?: B2cSourceFailureRecord[];
  postingReadinessRows?: Parameters<typeof summarizeFinancePostingReadiness>[0];
  pendingCandidates?: B2cPendingCandidateRecord[];
}): B2cWorkspaceOverview {
  const items = [
    ...buildB2cPendingCandidateWorkItems(input.pendingCandidates ?? []),
    ...buildB2cWorkItems({
    records: input.ledgerRows.filter((row) => row.recordType === "Payment").map(toB2cWorkItemRecord),
    sourceFailures: input.sourceFailures ?? [],
    postingReadiness: input.postingReadinessRows ? summarizeFinancePostingReadiness(input.postingReadinessRows) : undefined,
    readyToPostHref: READY_TO_POST_HREF,
    }),
  ];
  return { items, counts: summarizeB2cWorkItemCounts(items), pendingCandidates: input.pendingCandidates ?? [] };
}

type FailedSyncRun = { id: string; provider: "stripe" | "tap" };
type PendingCandidateRow = {
  id: string;
  import_id: string;
  candidate_kind: "new" | "ambiguous" | "existing_payment" | "removed";
  source_identity: string;
  finance_row_ids: string[];
  prior_lineage_ids: string[];
  prior_payment_ids: string[];
};
type CandidateStagingRow = {
  id: string;
  customer_name_raw: string | null;
  normalized_customer_name: string | null;
  customer_email_raw: string | null;
  amount_usd: string | null;
  occurred_on: string | null;
};

/** Loads the Admin Work queue overview. Reuses the dashboard snapshot and Task 2's Finance posting readiness RPC. */
export class SupabaseB2cWorkspaceRepository {
  constructor(private readonly client: DatabaseClient) {}

  private async listFailedSourceRuns(): Promise<B2cSourceFailureRecord[]> {
    const { data, error } = await this.client
      .from("integration_sync_runs")
      .select("id,provider")
      .in("provider", ["stripe", "tap"])
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error("Could not load B2C source sync runs.");
    const seenProviders = new Set<string>();
    const runs: FailedSyncRun[] = [];
    for (const run of (data ?? []) as FailedSyncRun[]) {
      if (seenProviders.has(run.provider)) continue;
      seenProviders.add(run.provider);
      runs.push(run);
    }
    return runs.map((run) => ({
      id: run.id,
      provider: run.provider,
      reason: `The last ${run.provider === "stripe" ? "Stripe" : "Tap"} sync failed. Retry it from Sources.`,
      href: "/operations/b2c?tab=sources",
    }));
  }

  /** Loads only unresolved, actionable import-version candidates with one representative source row. */
  private async listPendingImportVersionCandidates(): Promise<B2cPendingCandidateRecord[]> {
    const { data: candidateData, error: candidatesError } = await this.client
      .from("b2c_finance_import_version_candidates")
      .select("id,import_id,candidate_kind,source_identity,finance_row_ids,prior_lineage_ids,prior_payment_ids,b2c_finance_import_version_decisions!left(candidate_id)")
      .neq("candidate_kind", "removed")
      .is("b2c_finance_import_version_decisions.candidate_id", null);
    if (candidatesError) throw new Error("Could not load B2C Finance import-version candidates.");

    const candidates = (candidateData ?? []) as unknown as PendingCandidateRow[];
    if (candidates.length === 0) return [];

    const unresolvedCandidates = candidates.filter((candidate): candidate is PendingCandidateRow & {
      candidate_kind: B2cPendingCandidateRecord["candidateKind"];
    } => candidate.candidate_kind !== "removed");
    if (unresolvedCandidates.length === 0) return [];

    const representativeRowIds = [...new Set(unresolvedCandidates.map((candidate) => candidate.finance_row_ids[0]).filter((id): id is string => Boolean(id)))];
    const stagingRows: CandidateStagingRow[] = [];
    const rowIdBatches = chunkB2cWorkspaceQueryValues(representativeRowIds);
    for (let start = 0; start < rowIdBatches.length; start += WORKSPACE_QUERY_CONCURRENCY) {
      const results = await Promise.all(rowIdBatches.slice(start, start + WORKSPACE_QUERY_CONCURRENCY).map((rowIds) => this.client
        .from("b2c_finance_staging_rows")
        .select("id,customer_name_raw,normalized_customer_name,customer_email_raw,amount_usd,occurred_on")
        .in("id", rowIds)));
      if (results.some((result) => result.error)) throw new Error("Could not load B2C Finance candidate source rows.");
      for (const result of results) stagingRows.push(...((result.data ?? []) as CandidateStagingRow[]));
    }

    const stagingById = new Map(stagingRows.map((row) => [row.id, row]));
    return unresolvedCandidates.map((candidate) => {
      const sourceRow = stagingById.get(candidate.finance_row_ids[0]);
      return {
        candidateId: candidate.id,
        importId: candidate.import_id,
        candidateKind: candidate.candidate_kind,
        sourceIdentity: candidate.source_identity,
        financeRowIds: candidate.finance_row_ids,
        priorLineageIds: candidate.prior_lineage_ids,
        priorPaymentIds: candidate.prior_payment_ids,
        customerLabel: sourceRow?.customer_name_raw ?? sourceRow?.normalized_customer_name ?? sourceRow?.customer_email_raw ?? "this Payment Tracker row",
        amountUsd: sourceRow?.amount_usd ?? null,
        occurredOn: sourceRow?.occurred_on ?? null,
      };
    });
  }

  async overview(today = new Date()): Promise<B2cWorkspaceOverview> {
    const [snapshot, sourceFailures, postingReadinessRows, pendingCandidates] = await Promise.all([
      getB2cDashboardSnapshot(this.client, today),
      this.listFailedSourceRuns(),
      new B2cFinanceActionRepository(this.client).getFinancePostingReadinessRows(),
      this.listPendingImportVersionCandidates(),
    ]);
    return buildB2cWorkspaceOverview({
      ledgerRows: snapshot.rows.map((row) => decorateB2cLedgerRow(row, today)),
      sourceFailures,
      postingReadinessRows,
      pendingCandidates,
    });
  }
}
