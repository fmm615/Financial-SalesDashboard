import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/admin/b2c/payments/[paymentId]/finance-adjustments/route";
import { createServerSupabaseClient, type DatabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";
import {
  B2cPostedFinanceAdjustmentUnavailableError,
  SupabaseB2cFinancePaymentAdjustmentService,
  computeB2cPostedFinanceEffectiveState,
} from "@/server/services/adjust-b2c-finance-payment";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const adminUser = { id: "11111111-1111-4111-8111-111111111111" };
const paymentId = "85edf4fe-346b-483a-8053-199e6b1e2961";
const financeRowId = "22222222-2222-4222-8222-222222222222";

type MockConfig = {
  payment?: Record<string, unknown> | null;
  post?: { finance_row_id: string } | null;
  adjustments?: Array<Record<string, unknown>>;
  adjustmentsError?: boolean;
  rpc?: { data?: unknown; error?: unknown };
};

function mockClient({ payment, post, adjustments = [], adjustmentsError = false, rpc = { data: 1, error: null } }: MockConfig): DatabaseClient & { rpc: ReturnType<typeof vi.fn> } {
  const rpcMock = vi.fn().mockResolvedValue(rpc);
  const from = vi.fn((table: string) => {
    if (table === "b2c_payments") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: payment ?? null, error: null }) }) }) };
    }
    if (table === "b2c_finance_ledger_posts") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: post ?? null, error: null }) }) }) };
    }
    if (table === "b2c_finance_ledger_adjustments") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              order: async () => (adjustmentsError ? { data: null, error: { message: "boom" } } : { data: adjustments, error: null }),
            }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) },
    from,
    rpc: rpcMock,
  } as unknown as DatabaseClient & { rpc: ReturnType<typeof vi.fn> };
}

const eligiblePayment = {
  id: paymentId, source_system: "finance_tracker", payment_status: "succeeded",
  original_currency: "USD", amount_usd: "48.450000", occurred_on: "2026-11-01",
};

describe("computeB2cPostedFinanceEffectiveState", () => {
  it("returns the original payment as the effective state when there are no adjustments", () => {
    expect(computeB2cPostedFinanceEffectiveState("48.450000", "2026-11-01", [])).toEqual({ amountUsd: "48.450000", occurredOn: "2026-11-01" });
  });

  it("nets a reclassification pair into one effective balance on the corrected date", () => {
    const history = [
      { id: "a1", adjustmentRequestId: "req-1", entryIndex: 1, adjustmentKind: "date_reclassification" as const, amountDeltaUsd: "-48.450000", occurredOn: "2026-11-01", reason: "r", createdAt: "2026-08-19T00:00:00.000Z" },
      { id: "a2", adjustmentRequestId: "req-1", entryIndex: 2, adjustmentKind: "date_reclassification" as const, amountDeltaUsd: "48.450000", occurredOn: "2025-11-01", reason: "r", createdAt: "2026-08-19T00:00:00.000Z" },
    ];
    expect(computeB2cPostedFinanceEffectiveState("48.450000", "2026-11-01", history)).toEqual({ amountUsd: "48.450000", occurredOn: "2025-11-01" });
  });

  it("returns null when more than one business date carries a non-zero balance", () => {
    const history = [{ id: "a1", adjustmentRequestId: "req-1", entryIndex: 1, adjustmentKind: "amount_correction" as const, amountDeltaUsd: "10.000000", occurredOn: "2026-01-01", reason: "r", createdAt: "2026-08-19T00:00:00.000Z" }];
    expect(computeB2cPostedFinanceEffectiveState("48.450000", "2026-11-01", history)).toBeNull();
  });
});

describe("SupabaseB2cFinancePaymentAdjustmentService", () => {
  it("loads the current effective state and history for an eligible posted payment", async () => {
    const client = mockClient({
      payment: eligiblePayment,
      post: { finance_row_id: financeRowId },
      adjustments: [{ id: "adj-1", adjustment_request_id: "req-1", entry_index: 1, adjustment_kind: "amount_correction", amount_delta_usd: "1.000000", occurred_on: "2026-11-01", reason: "Recorded fee", created_at: "2026-08-01T00:00:00.000Z" }],
    });
    const context = await new SupabaseB2cFinancePaymentAdjustmentService(client).loadContext(paymentId);
    expect(context.currentAmountUsd).toBe("49.450000");
    expect(context.currentOccurredOn).toBe("2026-11-01");
    expect(context.history).toHaveLength(1);
    expect(context.history[0]).toMatchObject({ id: "adj-1", adjustmentRequestId: "req-1", reason: "Recorded fee" });
  });

  it("refuses to load a non-Finance-Tracker payment", async () => {
    const client = mockClient({ payment: { ...eligiblePayment, source_system: "stripe" }, post: { finance_row_id: financeRowId } });
    await expect(new SupabaseB2cFinancePaymentAdjustmentService(client).loadContext(paymentId)).rejects.toBeInstanceOf(B2cPostedFinanceAdjustmentUnavailableError);
  });

  it("refuses to load a payment that was never posted", async () => {
    const client = mockClient({ payment: eligiblePayment, post: null });
    await expect(new SupabaseB2cFinancePaymentAdjustmentService(client).loadContext(paymentId)).rejects.toBeInstanceOf(B2cPostedFinanceAdjustmentUnavailableError);
  });

  it("looks up the finance row and calls the expected-state RPC, never the unguarded one, with a generated idempotency key", async () => {
    const client = mockClient({ post: { finance_row_id: financeRowId }, rpc: { data: 1, error: null } });
    const result = await new SupabaseB2cFinancePaymentAdjustmentService(client).apply(paymentId, {
      expectedOccurredOn: "2026-11-01", expectedAmountUsd: "48.450000", verifiedOccurredOn: "2025-11-01", reason: "Finance verified the true business date.",
    });
    expect(result).toEqual({ insertedEntries: 1 });
    expect(client.rpc).toHaveBeenCalledWith("apply_b2c_finance_posted_adjustment_with_expected_state", expect.objectContaining({
      p_finance_row_id: financeRowId,
      p_occurred_on: "2025-11-01",
      p_amount_usd: null,
      p_customer_name: null,
      p_category_raw: null,
      p_expected_amount_usd: "48.450000",
      p_expected_occurred_on: "2026-11-01",
      p_reason: "Finance verified the true business date.",
    }));
    const call = client.rpc.mock.calls[0][1] as { p_adjustment_request_id: string };
    expect(call.p_adjustment_request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("surfaces a stale-balance rejection from the RPC as a typed, safe error", async () => {
    const client = mockClient({ post: { finance_row_id: financeRowId }, rpc: { data: null, error: { message: "changed after it was opened" } } });
    await expect(new SupabaseB2cFinancePaymentAdjustmentService(client).apply(paymentId, {
      expectedOccurredOn: "2026-11-01", expectedAmountUsd: "48.450000", verifiedOccurredOn: "2025-11-01", reason: "Finance verified the true business date.",
    })).rejects.toBeInstanceOf(B2cPostedFinanceAdjustmentUnavailableError);
  });
});

describe("B2C posted Finance adjustment API", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires an administrator before reading the posted balance", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await GET(new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/finance-adjustments`), { params: Promise.resolve({ paymentId }) });

    expect(response.status).toBe(403);
  });

  it("rejects an invalid payment id before any read", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) } } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await GET(new NextRequest("http://localhost/api/admin/b2c/payments/not-a-uuid/finance-adjustments"), { params: Promise.resolve({ paymentId: "not-a-uuid" }) });

    expect(response.status).toBe(422);
  });

  it("returns the current effective posted balance for an Admin", async () => {
    createServerClientMock.mockResolvedValue(mockClient({ payment: eligiblePayment, post: { finance_row_id: financeRowId } }));
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await GET(new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/finance-adjustments`), { params: Promise.resolve({ paymentId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.context).toMatchObject({ paymentId, currentAmountUsd: "48.450000", currentOccurredOn: "2026-11-01" });
  });

  it("rejects a request with neither a corrected amount nor a corrected date", async () => {
    createServerClientMock.mockResolvedValue(mockClient({ post: { finance_row_id: financeRowId } }));
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await POST(new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/finance-adjustments`, {
      method: "POST",
      body: JSON.stringify({ expectedOccurredOn: "2026-11-01", expectedAmountUsd: "48.45", reason: "Finance verified the correction." }),
    }), { params: Promise.resolve({ paymentId }) });

    expect(response.status).toBe(422);
  });

  it("rejects a request missing a meaningful reason", async () => {
    createServerClientMock.mockResolvedValue(mockClient({ post: { finance_row_id: financeRowId } }));
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await POST(new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/finance-adjustments`, {
      method: "POST",
      body: JSON.stringify({ expectedOccurredOn: "2026-11-01", expectedAmountUsd: "48.45", verifiedOccurredOn: "2025-11-01", reason: "" }),
    }), { params: Promise.resolve({ paymentId }) });

    expect(response.status).toBe(422);
  });

  it("applies a verified date correction and never lets the browser send a signed adjustment row", async () => {
    const client = mockClient({ post: { finance_row_id: financeRowId }, rpc: { data: 1, error: null } });
    createServerClientMock.mockResolvedValue(client);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await POST(new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/finance-adjustments`, {
      method: "POST",
      body: JSON.stringify({ expectedOccurredOn: "2026-11-01", expectedAmountUsd: "48.45", verifiedOccurredOn: "2025-11-01", reason: "Finance verified the true business date from the source statement." }),
    }), { params: Promise.resolve({ paymentId }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ insertedEntries: 1 });
    expect(client.rpc).toHaveBeenCalledWith("apply_b2c_finance_posted_adjustment_with_expected_state", expect.objectContaining({
      p_finance_row_id: financeRowId,
      p_occurred_on: "2025-11-01",
      p_amount_usd: null,
      p_expected_amount_usd: "48.45",
      p_expected_occurred_on: "2026-11-01",
    }));
  });

  it("returns a safe 422 when the RPC rejects a stale expected balance", async () => {
    createServerClientMock.mockResolvedValue(mockClient({ post: { finance_row_id: financeRowId }, rpc: { data: null, error: { message: "changed after it was opened" } } }));
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await POST(new NextRequest(`http://localhost/api/admin/b2c/payments/${paymentId}/finance-adjustments`, {
      method: "POST",
      body: JSON.stringify({ expectedOccurredOn: "2026-11-01", expectedAmountUsd: "48.45", verifiedOccurredOn: "2025-11-01", reason: "Finance verified the true business date." }),
    }), { params: Promise.resolve({ paymentId }) });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBeTruthy();
  });
});
