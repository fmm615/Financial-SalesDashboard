import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as decideLineage } from "@/app/api/admin/b2c/finance-imports/[importId]/lineage-decisions/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);

const importId = "22222222-2222-4222-8222-222222222222";
const candidateId = "33333333-3333-4333-8333-333333333333";

function decisionRequest(importIdForUrl: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/b2c/finance-imports/${importIdForUrl}/lineage-decisions`, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });
}

function authenticatedClient(insert: ReturnType<typeof vi.fn>) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) },
    from: vi.fn().mockReturnValue({ insert }),
  };
}

describe("B2C Finance lineage decision API", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a Viewer before it can write a B2C Finance lineage decision", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await decideLineage(
      decisionRequest(importId, { decision: "confirm_new", candidateId, reason: "Finance confirmed this is a genuinely new payment." }),
      { params: Promise.resolve({ importId }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });

  it("rejects an invalid B2C Finance import id before touching the database", async () => {
    const insert = vi.fn();
    const client = authenticatedClient(insert);
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await decideLineage(
      decisionRequest("not-a-uuid", { decision: "confirm_new", candidateId, reason: "Finance confirmed this is a genuinely new payment." }),
      { params: Promise.resolve({ importId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Invalid B2C Finance import." });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a decision whose target does not match its decision kind", async () => {
    const insert = vi.fn();
    const client = authenticatedClient(insert);
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await decideLineage(
      decisionRequest(importId, {
        decision: "confirm_new",
        candidateId,
        targetLineageId: "44444444-4444-4444-8444-444444444444",
        reason: "Finance confirmed this is a genuinely new payment.",
      }),
      { params: Promise.resolve({ importId }) },
    );

    expect(response.status).toBe(422);
    expect(insert).not.toHaveBeenCalled();
  });

  it("records only the admin-decided lineage resolution", async () => {
    const insert = vi.fn().mockReturnValue({ select: () => ({ single: vi.fn().mockResolvedValue({ data: { id: "55555555-5555-4555-8555-555555555555" }, error: null }) }) });
    const client = authenticatedClient(insert);
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await decideLineage(
      decisionRequest(importId, {
        decision: "link_revision",
        candidateId,
        targetLineageId: "44444444-4444-4444-8444-444444444444",
        reason: "Finance confirmed this row revises the same prior payment.",
      }),
      { params: Promise.resolve({ importId }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ decisionId: "55555555-5555-4555-8555-555555555555" });
    expect(client.from).toHaveBeenCalledWith("b2c_finance_import_version_decisions");
    expect(insert).toHaveBeenCalledWith({
      import_id: importId,
      candidate_id: candidateId,
      decision: "link_revision",
      target_lineage_id: "44444444-4444-4444-8444-444444444444",
      target_payment_id: null,
      reason: "Finance confirmed this row revises the same prior payment.",
    });
  });

  it("surfaces a second conflicting decision on the same candidate as a save failure", async () => {
    const insert = vi.fn().mockReturnValue({ select: () => ({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "This B2C Finance import version candidate already has a decision" } }) }) });
    const client = authenticatedClient(insert);
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await decideLineage(
      decisionRequest(importId, { decision: "confirm_new", candidateId, reason: "Finance confirmed this is a genuinely new payment." }),
      { params: Promise.resolve({ importId }) },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "The B2C Finance lineage decision could not be saved." });
  });
});
