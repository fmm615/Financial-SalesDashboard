import { describe, expect, it, vi } from "vitest";
import { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";
import { SupabaseTapSyncRepository } from "@/server/repositories/stripe-sync-repository";

function createClient() {
  const update = vi.fn();
  const readQuery = {
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { records_processed: 389, records_failed: 0 }, error: null }),
  };
  const writeQuery = {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: "11111111-1111-4111-8111-111111111111", continuation_cursor: null, records_processed: 389, records_failed: 0 }, error: null }),
  };
  update.mockReturnValue(writeQuery);
  return {
    client: { from: vi.fn().mockReturnValueOnce({ select: vi.fn().mockReturnValue(readQuery) }).mockReturnValueOnce({ update }) } as never,
    update,
  };
}

describe("historical backfill retry status", () => {
  it("clears a prior Tap failure when the resumed import completes", async () => {
    const { client, update } = createClient();

    await new SupabaseTapSyncRepository(client).finishHistoricalBackfillBatch({
      runId: "11111111-1111-4111-8111-111111111111", processed: 0, failed: 0, nextCursor: null,
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", safe_error_summary: null, failed_at: null }));
  });

  it("clears a prior HubSpot failure when the resumed import completes", async () => {
    const { client, update } = createClient();

    await new SupabaseHubSpotSyncRepository(client).finishHistoricalBackfillBatch({
      runId: "11111111-1111-4111-8111-111111111111", processed: 0, failed: 0, nextCursor: null,
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", safe_error_summary: null, failed_at: null }));
  });
});
