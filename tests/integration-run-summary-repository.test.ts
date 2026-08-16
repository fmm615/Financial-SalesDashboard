import { describe, expect, it, vi } from "vitest";
import { IntegrationRunSummaryRepository } from "@/server/repositories/integration-run-summary-repository";

function createClient(rows: unknown[] | null, error: { message: string } | null = null) {
  const order = vi.fn().mockResolvedValue({ data: rows, error });
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order,
  };

  return {
    client: { from: vi.fn().mockReturnValue(query) } as never,
    query,
  };
}

describe("IntegrationRunSummaryRepository", () => {
  it("returns one latest persisted historical-backfill summary per provider", async () => {
    const { client, query } = createClient([
      { provider: "stripe", status: "completed", records_processed: 230, records_failed: 0, completed_at: "2026-08-16T12:00:00.000Z", safe_error_summary: null },
      { provider: "stripe", status: "completed", records_processed: 10, records_failed: 0, completed_at: "2026-08-15T12:00:00.000Z", safe_error_summary: null },
      { provider: "hubspot", status: "failed", records_processed: 51, records_failed: 2, completed_at: null, safe_error_summary: "Safe source error." },
    ]);

    await expect(new IntegrationRunSummaryRepository(client).listLatestHistoricalBackfills()).resolves.toEqual([
      { provider: "stripe", status: "completed", totalProcessed: 230, totalFailed: 0, completedAt: "2026-08-16T12:00:00.000Z", safeErrorSummary: null },
      { provider: "tap", status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null },
      { provider: "hubspot", status: "failed", totalProcessed: 51, totalFailed: 2, completedAt: null, safeErrorSummary: "Safe source error." },
    ]);

    expect(query.select).toHaveBeenCalledWith("provider,status,records_processed,records_failed,completed_at,safe_error_summary");
    expect(query.eq).toHaveBeenCalledWith("operation_type", "historical_backfill");
    expect(query.in).toHaveBeenCalledWith("provider", ["stripe", "tap", "hubspot"]);
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("throws a safe repository error when saved status cannot be read", async () => {
    const { client } = createClient(null, { message: "permission denied" });

    await expect(new IntegrationRunSummaryRepository(client).listLatestHistoricalBackfills())
      .rejects.toThrow("Could not load saved integration runs: permission denied");
  });
});
