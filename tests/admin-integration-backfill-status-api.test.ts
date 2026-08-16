import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/integrations/backfill-status/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({
  getApprovedRole: vi.fn(),
  listLatestHistoricalBackfills: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: mocks.getApprovedRole }));
vi.mock("@/server/repositories/integration-run-summary-repository", () => ({
  IntegrationRunSummaryRepository: class {
    listLatestHistoricalBackfills = mocks.listLatestHistoricalBackfills;
  },
}));

const createServerClientMock = vi.mocked(createServerSupabaseClient);

describe("GET /api/admin/integrations/backfill-status", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a non-Admin before reading saved integration runs", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
    expect(mocks.listLatestHistoricalBackfills).not.toHaveBeenCalled();
  });

  it("returns the latest safe backfill summaries to an Admin", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never;
    createServerClientMock.mockResolvedValue(client);
    mocks.getApprovedRole.mockResolvedValue("admin");
    mocks.listLatestHistoricalBackfills.mockResolvedValue([
      { provider: "stripe", status: "completed", totalProcessed: 230, totalFailed: 0, completedAt: "2026-08-16T12:00:00.000Z", safeErrorSummary: null },
      { provider: "tap", status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null },
      { provider: "hubspot", status: "failed", totalProcessed: 51, totalFailed: 2, completedAt: null, safeErrorSummary: "Safe source error." },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ summaries: await mocks.listLatestHistoricalBackfills.mock.results[0].value });
  });

  it("returns a safe error when saved integration history cannot be loaded", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never;
    createServerClientMock.mockResolvedValue(client);
    mocks.getApprovedRole.mockResolvedValue("admin");
    mocks.listLatestHistoricalBackfills.mockRejectedValue(new Error("database host details"));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not load saved integration run summaries." });
  });
});
