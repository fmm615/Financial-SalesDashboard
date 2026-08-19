import type { DatabaseClient } from "@/lib/supabase/server";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";
import { decorateB2cLedgerRow, type B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";
import { getB2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";
import { summarizeFinancePostingReadiness } from "@/server/services/b2c-finance-action-center";
import {
  buildB2cWorkItems,
  type B2cSourceFailureRecord,
  type B2cWorkItem,
  type B2cWorkItemRecord,
} from "@/server/services/b2c-work-items";

export type B2cWorkspaceCounts = { all: number; data: number; duplicates: number; reconciliation: number; ready_to_post: number };

export type B2cWorkspaceOverview = {
  items: B2cWorkItem[];
  counts: B2cWorkspaceCounts;
};

/** Summarizes the internally detailed work items into the five visible Work queue filter counts. */
export function summarizeB2cWorkItemCounts(items: B2cWorkItem[]): B2cWorkspaceCounts {
  const counts: B2cWorkspaceCounts = { all: items.length, data: 0, duplicates: 0, reconciliation: 0, ready_to_post: 0 };
  for (const item of items) counts[item.visibleGroup] += 1;
  return counts;
}

const READY_TO_POST_HREF = "/operations/b2c?tab=work&queue=ready_to_post";

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
}): B2cWorkspaceOverview {
  const items = buildB2cWorkItems({
    records: input.ledgerRows.filter((row) => row.recordType === "Payment").map(toB2cWorkItemRecord),
    sourceFailures: input.sourceFailures ?? [],
    postingReadiness: input.postingReadinessRows ? summarizeFinancePostingReadiness(input.postingReadinessRows) : undefined,
    readyToPostHref: READY_TO_POST_HREF,
  });
  return { items, counts: summarizeB2cWorkItemCounts(items) };
}

type FailedSyncRun = { id: string; provider: "stripe" | "tap" };

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

  async overview(today = new Date()): Promise<B2cWorkspaceOverview> {
    const [snapshot, sourceFailures, postingReadinessRows] = await Promise.all([
      getB2cDashboardSnapshot(this.client, today),
      this.listFailedSourceRuns(),
      new B2cFinanceActionRepository(this.client).getFinancePostingReadinessRows(),
    ]);
    return buildB2cWorkspaceOverview({
      ledgerRows: snapshot.rows.map(decorateB2cLedgerRow),
      sourceFailures,
      postingReadinessRows,
    });
  }
}
