import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b2c/workspace/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({
  getApprovedRole: vi.fn(),
  page: vi.fn(),
  overview: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: mocks.getApprovedRole }));
vi.mock("@/server/repositories/b2c-ledger-repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SupabaseB2cLedgerRepository: class {
    page = mocks.page;
  },
}));
vi.mock("@/server/repositories/b2c-workspace-repository", () => ({
  SupabaseB2cWorkspaceRepository: class {
    overview = mocks.overview;
  },
}));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const approvedUser = { id: "11111111-1111-4111-8111-111111111111" };

const stripeEvidenceRow = {
  id: "payment-1", recordType: "Payment", customerName: "Maya Al Khalifa", customerEmail: "maya@example.com", customerPhone: null,
  customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
  date: "Aug 1, 2026", dateValue: "2026-08-01", amountUsd: "$100.00", amountValueUsd: "100", sourceAmountUsd: "$100.00",
  sourceOriginalAmount: "100", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-01",
  category: "membership", membershipTier: null, billingInterval: null, source: "Stripe", paymentStatus: "Completed",
  providerReference: "ch_1", sourceSystem: "stripe", productReference: null, hasLocalCorrection: false, localCorrectionFields: [],
  hasFinanceException: false, openReviewFlags: [], issue: null,
  stripeEvidence: { originalAmount: "100", originalCurrency: "USD", amountRefunded: null, description: null, sellerMessage: "Confidential seller note", cardholderName: "Maya Al Khalifa", settlementGrossAmount: null, settlementFeeAmount: null, settlementFeeTaxAmount: null, settlementNetAmount: null, settlementCurrency: null, settlementExchangeRate: null, refunds: [] },
  decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "reportable", postingStatus: "not_applicable", blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
};

const ledgerPage = { rows: [stripeEvidenceRow], nextCursor: null, hasMore: false, totalCount: 1 };
const workspaceOverview = { items: [], counts: { all: 0, data: 0, duplicates: 0, reconciliation: 0, ready_to_post: 0 } };

describe("GET /api/b2c/workspace", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects an unauthenticated read before loading any B2C record", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Approved access is required." });
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects a user with no approved role", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.getApprovedRole.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));

    expect(response.status).toBe(403);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects a page limit above the 100-row maximum before reading the ledger", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.getApprovedRole.mockResolvedValue("viewer");

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?limit=101"));

    expect(response.status).toBe(422);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects an invalid reporting-decision filter", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.getApprovedRole.mockResolvedValue("viewer");

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?reportingDecision=made_up"));

    expect(response.status).toBe(422);
  });

  it("gives a Viewer the safe ledger page without Stripe evidence and without any work item", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.getApprovedRole.mockResolvedValue("viewer");
    mocks.page.mockResolvedValue(ledgerPage);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.role).toBe("viewer");
    expect(body.workItems).toBeNull();
    expect(body.ledger.rows).toHaveLength(1);
    expect(body.ledger.rows[0].stripeEvidence).toBeUndefined();
    expect(body.ledger.rows[0].decision.reportingDecision).toBe("reportable");
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("gives an Admin the same safe ledger page plus the Work queue overview", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.getApprovedRole.mockResolvedValue("admin");
    mocks.page.mockResolvedValue(ledgerPage);
    mocks.overview.mockResolvedValue(workspaceOverview);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?source=stripe&sort=amount_desc"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.role).toBe("admin");
    expect(body.workItems).toEqual(workspaceOverview);
    expect(body.ledger.rows[0].stripeEvidence).toBeUndefined();
    expect(mocks.page).toHaveBeenCalledWith({ source: "stripe", sort: "amount_desc" });
  });

  it("returns a safe error without leaking a raw repository failure", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.getApprovedRole.mockResolvedValue("admin");
    mocks.page.mockRejectedValue(new Error("raw B2C source content"));

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not load the B2C workspace." });
  });
});
