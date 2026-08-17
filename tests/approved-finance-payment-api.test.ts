import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/b2c/finance-ledger-posts/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({
  getApprovedRole: vi.fn(),
  postApprovedFinancePayments: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: mocks.getApprovedRole }));
vi.mock("@/server/repositories/b2c-finance-ledger-repository", () => ({
  SupabaseB2cFinanceLedgerRepository: class {
    postApprovedFinancePayments = mocks.postApprovedFinancePayments;
  },
}));

const createServerClientMock = vi.mocked(createServerSupabaseClient);

describe("POST /api/admin/b2c/finance-ledger-posts", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a non-Admin before posting any Finance rows", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await POST(new Request("http://localhost/api/admin/b2c/finance-ledger-posts", { method: "POST" }) as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
    expect(mocks.postApprovedFinancePayments).not.toHaveBeenCalled();
  });

  it("posts through the one protected Finance-ledger operation", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never;
    createServerClientMock.mockResolvedValue(client);
    mocks.getApprovedRole.mockResolvedValue("admin");
    mocks.postApprovedFinancePayments.mockResolvedValue({ postedPayments: 2, alreadyPostedPayments: 1, skippedRows: 3 });

    const response = await POST(new Request("http://localhost/api/admin/b2c/finance-ledger-posts", { method: "POST" }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { postedPayments: 2, alreadyPostedPayments: 1, skippedRows: 3 } });
    expect(mocks.postApprovedFinancePayments).toHaveBeenCalledTimes(1);
  });

  it("returns a safe error when the protected posting result is unavailable", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never;
    createServerClientMock.mockResolvedValue(client);
    mocks.getApprovedRole.mockResolvedValue("admin");
    mocks.postApprovedFinancePayments.mockRejectedValue(new Error("raw Finance source content"));

    const response = await POST(new Request("http://localhost/api/admin/b2c/finance-ledger-posts", { method: "POST" }) as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not post approved B2C Finance payments." });
  });
});
