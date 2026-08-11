import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/targets/operational/[targetId]/progress/route";
import { POST as reviseOperationalTarget } from "@/app/api/admin/targets/operational/[targetId]/revise/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);

describe("operational target progress API", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects an unauthenticated progress write before accessing target data", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await POST(new NextRequest("http://localhost/api/admin/targets/operational/11111111-1111-4111-8111-111111111111/progress", {
      method: "POST", body: JSON.stringify({ actualValue: "42", effectiveOn: "2026-08-11", evidenceNote: "Ticketing report" }),
    }), { params: Promise.resolve({ targetId: "11111111-1111-4111-8111-111111111111" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });

  it("rejects an unauthenticated operational revision before accessing target data", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await reviseOperationalTarget(new NextRequest("http://localhost/api/admin/targets/operational/11111111-1111-4111-8111-111111111111/revise", {
      method: "POST", body: JSON.stringify({
        displayName: "Revised tickets", valueKind: "quantity", targetValue: "125", unitLabel: "tickets",
        periodStart: "2026-01-01", periodEnd: "2026-12-31", status: "active",
        financeReference: "Updated Summit plan", revisionReason: "Finance approved revision",
      }),
    }), { params: Promise.resolve({ targetId: "11111111-1111-4111-8111-111111111111" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });
});
