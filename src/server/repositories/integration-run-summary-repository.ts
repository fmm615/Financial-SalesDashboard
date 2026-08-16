import type { DatabaseClient } from "@/lib/supabase/server";

export type IntegrationProvider = "stripe" | "tap" | "hubspot";
export type IntegrationBackfillStatus = "not_started" | "pending" | "processing" | "completed" | "failed" | "cancelled";

export type IntegrationBackfillSummary = {
  provider: IntegrationProvider;
  status: IntegrationBackfillStatus;
  totalProcessed: number | null;
  totalFailed: number | null;
  completedAt: string | null;
  safeErrorSummary: string | null;
};

const providers: IntegrationProvider[] = ["stripe", "tap", "hubspot"];

function isIntegrationProvider(value: string): value is IntegrationProvider {
  return providers.includes(value as IntegrationProvider);
}

/** Reads only persisted, safe historical-backfill progress for the Admin status screen. */
export class IntegrationRunSummaryRepository {
  constructor(private readonly client: DatabaseClient) {}

  async listLatestHistoricalBackfills(): Promise<IntegrationBackfillSummary[]> {
    const { data, error } = await this.client
      .from("integration_sync_runs")
      .select("provider,status,records_processed,records_failed,completed_at,safe_error_summary")
      .eq("operation_type", "historical_backfill")
      .in("provider", providers)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Could not load saved integration runs: ${error.message}`);

    const latestByProvider = new Map<IntegrationProvider, NonNullable<typeof data>[number]>();
    for (const row of data ?? []) {
      if (isIntegrationProvider(row.provider) && !latestByProvider.has(row.provider)) {
        latestByProvider.set(row.provider, row);
      }
    }

    return providers.map((provider) => {
      const row = latestByProvider.get(provider);
      if (!row) {
        return {
          provider,
          status: "not_started",
          totalProcessed: null,
          totalFailed: null,
          completedAt: null,
          safeErrorSummary: null,
        };
      }

      return {
        provider,
        status: row.status,
        totalProcessed: row.records_processed,
        totalFailed: row.records_failed,
        completedAt: row.completed_at,
        safeErrorSummary: row.safe_error_summary,
      };
    });
  }
}
