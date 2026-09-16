import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getDuplicateGroup } from "@/app/api/admin/b2c/payments/[paymentId]/duplicate-group/route";
import { POST as saveDuplicateDecision } from "@/app/api/admin/b2c/payment-duplicate-groups/[groupId]/decision/route";
import { POST as dismissStaleDuplicate } from "@/app/api/admin/b2c/review-flags/[flagId]/dismiss-stale-duplicate/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const repositoryMocks = vi.hoisted(() => ({
  getOpenGroupForPayment: vi.fn(),
  getOpenGroup: vi.fn(),
  getOpenPossibleDuplicateFlagForPayment: vi.fn(),
}));
const middlewareRoleMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getSessionUser: (client: { auth: { getUser: () => unknown } }) => client.auth.getUser() }));
vi.mock("@/lib/auth/middleware-role", () => ({ requireMiddlewareRole: middlewareRoleMock }));
vi.mock("@/server/repositories/b2c-payment-duplicate-repository", () => ({
  B2cPaymentDuplicateRepository: vi.fn().mockImplementation(() => repositoryMocks),
}));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const adminUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const paymentId = "11111111-1111-4111-8111-111111111111";
const otherPaymentId = "22222222-2222-4222-8222-222222222222";
const groupId = "33333333-3333-4333-8333-333333333333";
const flagId = "44444444-4444-4444-8444-444444444444";
const reason = "Finance verified the retained provider receipt.";

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function routeContext<Key extends string>(key: Key, value: string): { params: Promise<Record<Key, string>> } {
  return { params: Promise.resolve({ [key]: value } as Record<Key, string>) };
}

function mockClient(user: { id: string } | null = { id: adminUserId }) {
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    rpc: vi.fn(),
  };
  createServerClientMock.mockResolvedValue(client as never);
  return client;
}

function openGroupRow() {
  return {
    id: groupId,
    detection_reason: "Matching verified payment facts within 48 hours.",
    members: [
      {
        payment_id: otherPaymentId,
        payment: {
          id: otherPaymentId,
          source_system: "tap" as const,
          provider_transaction_id: "tap_safe_reference",
          customer_name: "Member Two",
          customer_email: "member@playbook.test",
          original_amount: "125.000000",
          original_currency: "USD",
          amount_usd: "125.000000",
          occurred_on: "2026-08-23",
          payment_status: "succeeded" as const,
          local_override: null,
          raw_payload: { secret: true },
        },
      },
      {
        payment_id: paymentId,
        payment: {
          id: paymentId,
          source_system: "stripe" as const,
          provider_transaction_id: "ch_safe_reference",
          customer_name: "Member One",
          customer_email: "source@playbook.test",
          original_amount: "110.000000",
          original_currency: "USD",
          amount_usd: "110.000000",
          occurred_on: "2026-08-22",
          payment_status: "succeeded" as const,
          source_metadata: { secret: true },
          local_override: {
            customer_name: "Member One Corrected",
            customer_email: "member@playbook.test",
            local_amount_usd: "125.000000",
            local_occurred_on: "2026-08-23",
            actor_email: "admin@playbook.test",
          },
        },
      },
    ],
  };
}

describe("B2C payment duplicate API authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  const requests = [
    {
      name: "group read",
      invoke: () => getDuplicateGroup(
        new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/duplicate-group`),
        routeContext("paymentId", paymentId),
      ),
    },
    {
      name: "group decision",
      invoke: () => saveDuplicateDecision(
        jsonRequest(`http://localhost/api/admin/b2c/payment-duplicate-groups/${groupId}/decision`, {
          decision: "keep_one", canonicalPaymentId: paymentId, reason,
        }),
        routeContext("groupId", groupId),
      ),
    },
    {
      name: "stale flag dismissal",
      invoke: () => dismissStaleDuplicate(
        jsonRequest(`http://localhost/api/admin/b2c/review-flags/${flagId}/dismiss-stale-duplicate`, { reason }),
        routeContext("flagId", flagId),
      ),
    },
  ];

  it.each(requests)("rejects an unauthenticated $name before repository or RPC access", async ({ invoke }) => {
    const client = mockClient(null);

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(middlewareRoleMock).not.toHaveBeenCalled();
    expect(repositoryMocks.getOpenGroupForPayment).not.toHaveBeenCalled();
    expect(repositoryMocks.getOpenGroup).not.toHaveBeenCalled();
    expect(repositoryMocks.getOpenPossibleDuplicateFlagForPayment).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each(requests)("rejects a Viewer $name before repository or RPC access", async ({ invoke }) => {
    const client = mockClient();
    middlewareRoleMock.mockReturnValue("viewer");

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(repositoryMocks.getOpenGroupForPayment).not.toHaveBeenCalled();
    expect(repositoryMocks.getOpenGroup).not.toHaveBeenCalled();
    expect(repositoryMocks.getOpenPossibleDuplicateFlagForPayment).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("B2C payment duplicate group read API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient();
    middlewareRoleMock.mockReturnValue("admin");
  });

  it("rejects an invalid payment ID before repository access", async () => {
    const response = await getDuplicateGroup(
      new NextRequest("http://localhost/api/admin/b2c/payments/not-a-uuid/duplicate-group"),
      routeContext("paymentId", "not-a-uuid"),
    );

    expect(response.status).toBe(422);
    expect(repositoryMocks.getOpenGroupForPayment).not.toHaveBeenCalled();
  });

  it("returns a mapped group and never queries the legacy fallback flag", async () => {
    repositoryMocks.getOpenGroupForPayment.mockResolvedValue(openGroupRow());

    const response = await getDuplicateGroup(
      new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/duplicate-group`),
      routeContext("paymentId", paymentId),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("group");
    expect(payload.group.members.map((member: { paymentId: string }) => member.paymentId)).toEqual([paymentId, otherPaymentId]);
    expect(repositoryMocks.getOpenPossibleDuplicateFlagForPayment).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain("source_metadata");
    expect(JSON.stringify(payload)).not.toContain("raw_payload");
    expect(JSON.stringify(payload)).not.toContain("admin@playbook.test");
  });

  it("returns an ungrouped legacy flag only when no group exists", async () => {
    repositoryMocks.getOpenGroupForPayment.mockResolvedValue(null);
    repositoryMocks.getOpenPossibleDuplicateFlagForPayment.mockResolvedValue({ id: flagId });

    const response = await getDuplicateGroup(
      new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/duplicate-group`),
      routeContext("paymentId", paymentId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "ungrouped_flag", flagId });
  });

  it("returns none when neither a group nor an open legacy flag exists", async () => {
    repositoryMocks.getOpenGroupForPayment.mockResolvedValue(null);
    repositoryMocks.getOpenPossibleDuplicateFlagForPayment.mockResolvedValue(null);

    const response = await getDuplicateGroup(
      new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/duplicate-group`),
      routeContext("paymentId", paymentId),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "none" });
  });

  it("does not expose repository, SQL, or source detail on failure", async () => {
    repositoryMocks.getOpenGroupForPayment.mockRejectedValue(
      new Error("select source_metadata from private_table: relation does not exist"),
    );

    const response = await getDuplicateGroup(
      new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/duplicate-group`),
      routeContext("paymentId", paymentId),
    );

    expect(response.status).toBe(500);
    const payload = JSON.stringify(await response.json());
    expect(payload).not.toContain("source_metadata");
    expect(payload).not.toContain("private_table");
    expect(payload).not.toContain("relation");
  });
});

describe("B2C payment duplicate decision API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient();
    middlewareRoleMock.mockReturnValue("admin");
  });

  it("rejects invalid group IDs and malformed bodies before reads or writes", async () => {
    const invalidIdResponse = await saveDuplicateDecision(
      jsonRequest("http://localhost/api/admin/b2c/payment-duplicate-groups/not-a-uuid/decision", {
        decision: "keep_all", canonicalPaymentId: null, reason,
      }),
      routeContext("groupId", "not-a-uuid"),
    );
    expect(invalidIdResponse.status).toBe(422);

    const invalidBodyResponse = await saveDuplicateDecision(
      jsonRequest(`http://localhost/api/admin/b2c/payment-duplicate-groups/${groupId}/decision`, {
        decision: "keep_all", canonicalPaymentId: paymentId, reason,
      }),
      routeContext("groupId", groupId),
    );
    expect(invalidBodyResponse.status).toBe(422);
    expect(repositoryMocks.getOpenGroup).not.toHaveBeenCalled();
  });

  it("resolves through the request client and returns the pre-resolution member IDs", async () => {
    repositoryMocks.getOpenGroup.mockResolvedValue(openGroupRow());
    const client = mockClient();
    client.rpc.mockResolvedValue({ data: null, error: null });

    const response = await saveDuplicateDecision(
      jsonRequest(`http://localhost/api/admin/b2c/payment-duplicate-groups/${groupId}/decision`, {
        decision: "keep_one", canonicalPaymentId: paymentId, reason,
      }),
      routeContext("groupId", groupId),
    );

    expect(response.status).toBe(201);
    expect(client.rpc).toHaveBeenCalledWith("resolve_b2c_payment_duplicate_group", {
      p_group_id: groupId,
      p_decision: "keep_one",
      p_canonical_payment_id: paymentId,
      p_reason: reason,
    });
    await expect(response.json()).resolves.toEqual({
      groupId,
      resolvedPaymentIds: [paymentId, otherPaymentId],
    });
  });

  it("returns a safe error without leaking raw RPC detail", async () => {
    repositoryMocks.getOpenGroup.mockResolvedValue(openGroupRow());
    const client = mockClient();
    client.rpc.mockResolvedValue({
      data: null,
      error: { message: "duplicate key from raw_payload private-card-data" },
    });

    const response = await saveDuplicateDecision(
      jsonRequest(`http://localhost/api/admin/b2c/payment-duplicate-groups/${groupId}/decision`, {
        decision: "keep_all", canonicalPaymentId: null, reason: "Both receipts are separate payments.",
      }),
      routeContext("groupId", groupId),
    );

    expect(response.status).toBe(422);
    const payload = JSON.stringify(await response.json());
    expect(payload).not.toContain("raw_payload");
    expect(payload).not.toContain("private-card-data");
    expect(payload).not.toContain("duplicate key");
  });

  it("converts a rejected decision RPC into the same safe error response", async () => {
    repositoryMocks.getOpenGroup.mockResolvedValue(openGroupRow());
    const client = mockClient();
    client.rpc.mockRejectedValue(new Error("source_metadata raw SQL exception"));

    const response = await saveDuplicateDecision(
      jsonRequest(`http://localhost/api/admin/b2c/payment-duplicate-groups/${groupId}/decision`, {
        decision: "keep_all", canonicalPaymentId: null, reason: "Both receipts are separate payments.",
      }),
      routeContext("groupId", groupId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "The B2C payment duplicate decision could not be saved.",
    });
  });
});

describe("stale B2C possible-duplicate dismissal API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient();
    middlewareRoleMock.mockReturnValue("admin");
  });

  it("rejects an invalid flag ID and a placeholder reason before RPC access", async () => {
    const client = mockClient();
    const invalidIdResponse = await dismissStaleDuplicate(
      jsonRequest("http://localhost/api/admin/b2c/review-flags/not-a-uuid/dismiss-stale-duplicate", { reason }),
      routeContext("flagId", "not-a-uuid"),
    );
    expect(invalidIdResponse.status).toBe(422);

    const invalidBodyResponse = await dismissStaleDuplicate(
      jsonRequest(`http://localhost/api/admin/b2c/review-flags/${flagId}/dismiss-stale-duplicate`, { reason: "---" }),
      routeContext("flagId", flagId),
    );
    expect(invalidBodyResponse.status).toBe(422);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("dismisses through the request-scoped client", async () => {
    const client = mockClient();
    client.rpc.mockResolvedValue({ data: null, error: null });

    const response = await dismissStaleDuplicate(
      jsonRequest(`http://localhost/api/admin/b2c/review-flags/${flagId}/dismiss-stale-duplicate`, { reason }),
      routeContext("flagId", flagId),
    );

    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("dismiss_stale_b2c_possible_duplicate_flag", {
      p_flag_id: flagId,
      p_reason: reason,
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not expose raw SQL errors", async () => {
    const client = mockClient();
    client.rpc.mockResolvedValue({ data: null, error: { message: "review_flags RLS raw SQL detail" } });

    const response = await dismissStaleDuplicate(
      jsonRequest(`http://localhost/api/admin/b2c/review-flags/${flagId}/dismiss-stale-duplicate`, { reason }),
      routeContext("flagId", flagId),
    );

    expect(response.status).toBe(422);
    const payload = JSON.stringify(await response.json());
    expect(payload).not.toContain("review_flags");
    expect(payload).not.toContain("raw SQL");
  });

  it("converts a rejected stale-dismissal RPC into the same safe error response", async () => {
    const client = mockClient();
    client.rpc.mockRejectedValue(new Error("raw_payload review_flags SQL exception"));

    const response = await dismissStaleDuplicate(
      jsonRequest(`http://localhost/api/admin/b2c/review-flags/${flagId}/dismiss-stale-duplicate`, { reason }),
      routeContext("flagId", flagId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "The stale B2C possible-duplicate review item could not be dismissed.",
    });
  });
});
