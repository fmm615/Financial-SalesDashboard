import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getReviewQueue } from "@/app/api/review-queue/route";
import { GET as getReviewQueueDetail } from "@/app/api/review-queue/[flagId]/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);

describe("Review Queue list API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects an unauthenticated queue read before accessing review records", async () => {
    createServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const response = await getReviewQueue(new NextRequest("http://localhost/api/review-queue"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Approved access is required." });
  });

  it("rejects an invalid filter before reading the queue", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await getReviewQueue(new NextRequest("http://localhost/api/review-queue?priority=6"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Priority: Too big: expected number to be <=5" });
  });

  it("rejects an invalid review flag identifier before loading its history", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await getReviewQueueDetail(
      new NextRequest("http://localhost/api/review-queue/not-a-uuid"),
      { params: Promise.resolve({ flagId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Invalid review queue item." });
  });
});
