import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getReviewQueue } from "@/app/api/review-queue/route";
import { GET as getReviewQueueDetail } from "@/app/api/review-queue/[flagId]/route";
import { POST as addReviewQueueNote } from "@/app/api/review-queue/[flagId]/notes/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

const mocks = vi.hoisted(() => ({ listFlags: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));
vi.mock("@/server/repositories/review-queue-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/repositories/review-queue-repository")>();
  return {
    ...actual,
    SupabaseReviewQueueRepository: class extends actual.SupabaseReviewQueueRepository {
      listFlags = mocks.listFlags;
    },
  };
});

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

  it("deep-links a B2C review flag to its corresponding B2C work item, not a second mutation surface", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");
    mocks.listFlags.mockResolvedValue([{
      id: "22222222-2222-4222-8222-222222222222",
      sourceArea: "b2c_payment",
      sourceRecordId: "33333333-3333-4333-8333-333333333333",
      flagType: "possible_duplicate",
      status: "open",
      priority: 2,
      reason: "Matched source records require an explicit Finance decision.",
      assignedTo: null,
      createdAt: "2026-08-10T09:00:00.000Z",
      resolvedAt: null,
    }]);

    const response = await getReviewQueue(new NextRequest("http://localhost/api/review-queue"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].nextAction).toEqual({
      kind: "navigate",
      href: "/operations/b2c?tab=work&record=33333333-3333-4333-8333-333333333333",
      label: "Open B2C work item",
    });
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

  it("refuses a Viewer note before it can write review history", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await addReviewQueueNote(
      new NextRequest("http://localhost/api/review-queue/22222222-2222-4222-8222-222222222222/notes", {
        method: "POST", body: JSON.stringify({ note: "Verified source reference with Finance" }), headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ flagId: "22222222-2222-4222-8222-222222222222" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });

  it("rejects a note payload that tries to resolve a flag", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await addReviewQueueNote(
      new NextRequest("http://localhost/api/review-queue/22222222-2222-4222-8222-222222222222/notes", {
        method: "POST", body: JSON.stringify({ note: "Verified source reference with Finance", status: "resolved" }), headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ flagId: "22222222-2222-4222-8222-222222222222" }) },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Invalid review note." });
  });

  it("stores only a validated Admin note on an existing flag", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) },
      from: (table: string) => table === "review_flags"
        ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "22222222-2222-4222-8222-222222222222" }, error: null }) }) }) }
        : { insert },
    };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await addReviewQueueNote(
      new NextRequest("http://localhost/api/review-queue/22222222-2222-4222-8222-222222222222/notes", {
        method: "POST", body: JSON.stringify({ note: "Verified source reference with Finance" }), headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ flagId: "22222222-2222-4222-8222-222222222222" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(insert).toHaveBeenCalledWith({ flag_id: "22222222-2222-4222-8222-222222222222", note: "Verified source reference with Finance" });
  });
});
