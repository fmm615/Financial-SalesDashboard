import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/b2c/payments/[paymentId]/evidence/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({ middlewareRole: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({
  getSessionUser: (client: { auth: { getUser: () => unknown } }) => client.auth.getUser(),
}));
vi.mock("@/lib/auth/middleware-role", () => ({ requireMiddlewareRole: mocks.middlewareRole }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const user = { id: "11111111-1111-4111-8111-111111111111" };
const paymentId = "90000000-0000-4000-8000-000000000001";

function request() {
  return new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/evidence`);
}

function params(id = paymentId) {
  return { params: Promise.resolve({ paymentId: id }) };
}

describe("GET /api/admin/b2c/payments/[paymentId]/evidence", () => {
  beforeEach(() => vi.resetAllMocks());

  it("loads exactly one Admin payment through the scoped evidence RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        payment_id: paymentId,
        source: "Stripe",
        source_system: "stripe",
        provider_reference: "ch_scoped",
        date_value: "2026-09-10",
        stripe_evidence: {
          originalAmount: "100.000000",
          originalCurrency: "USD",
          amountRefunded: null,
          description: "Annual renewal",
          sellerMessage: null,
          cardholderName: "Maya",
          settlementGrossAmount: null,
          settlementFeeAmount: null,
          settlementFeeTaxAmount: null,
          settlementNetAmount: null,
          settlementCurrency: null,
          settlementExchangeRate: null,
          refunds: [],
        },
      },
      error: null,
    });
    createServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
      rpc,
    } as never);
    mocks.middlewareRole.mockReturnValue("admin");

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      paymentId,
      source: "Stripe",
      sourceSystem: "stripe",
      providerReference: "ch_scoped",
      date: "Sep 10, 2026",
      stripeEvidence: { description: "Annual renewal", refunds: [] },
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_b2c_payment_evidence", { p_payment_id: paymentId });
  });

  it("rejects a Viewer before reading evidence", async () => {
    const rpc = vi.fn();
    createServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
      rpc,
    } as never);
    mocks.middlewareRole.mockReturnValue("viewer");

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 404 when the scoped RPC cannot find the payment", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    createServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
      rpc,
    } as never);
    mocks.middlewareRole.mockReturnValue("admin");

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "This B2C payment is unavailable." });
  });

  it("does not expose a database error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "secret provider payload" } });
    createServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
      rpc,
    } as never);
    mocks.middlewareRole.mockReturnValue("admin");

    const response = await GET(request(), params());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not load B2C source evidence." });
  });
});
