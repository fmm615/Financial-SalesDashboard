import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b2c/workspace/route";
import { GET as GET_LEDGER_EXPORT } from "@/app/api/b2c/workspace/export/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const mocks = vi.hoisted(() => ({
  middlewareRole: vi.fn(),
  page: vi.fn(),
  exportRows: vi.fn(),
  overview: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getSessionUser: (client: { auth: { getUser: () => unknown } }) => client.auth.getUser() }));
vi.mock("@/lib/auth/middleware-role", () => ({ requireMiddlewareRole: mocks.middlewareRole }));
vi.mock("@/server/repositories/b2c-ledger-repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SupabaseB2cLedgerRepository: class {
    page = mocks.page;
    exportRows = mocks.exportRows;
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
  membershipTier: null, billingInterval: null, source: "Stripe", paymentStatus: "Completed",
  providerReference: "ch_1", sourceSystem: "stripe", productReference: null, hasLocalCorrection: false, localCorrectionFields: [],
  hasFinanceException: false, openReviewFlags: [], issue: null,
  stripeEvidence: { originalAmount: "100", originalCurrency: "USD", amountRefunded: null, description: null, sellerMessage: "Confidential seller note", cardholderName: "Maya Al Khalifa", settlementGrossAmount: null, settlementFeeAmount: null, settlementFeeTaxAmount: null, settlementNetAmount: null, settlementCurrency: null, settlementExchangeRate: null, refunds: [] },
  decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "reportable", postingStatus: "not_applicable", blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
};

const ledgerPage = { rows: [stripeEvidenceRow], nextCursor: null, hasMore: false, totalCount: 1, filterMetadata: { sources: ["Stripe", "Tap"], issues: ["Needs follow-up"], foreignCurrencyCount: 2 } };
const workspaceOverview = { items: [], counts: { all: 0, data: 0, duplicates: 0, reconciliation: 0 } };

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
    mocks.middlewareRole.mockReturnValue(null);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));

    expect(response.status).toBe(403);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects a page limit above the 100-row maximum before reading the ledger", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?limit=101"));

    expect(response.status).toBe(422);
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects an invalid reporting-decision filter", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?reportingDecision=made_up"));

    expect(response.status).toBe(422);
  });

  it("rejects the retired unmapped-product issue filter while accepting every live issue filter", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");
    mocks.page.mockResolvedValue(ledgerPage);

    const retiredResponse = await GET(new NextRequest("http://localhost/api/b2c/workspace?issue=Unmapped%20product"));

    expect(retiredResponse.status).toBe(422);
    for (const issue of ["Possible duplicate", "Failed", "Missing customer email", "Needs follow-up", "Needs FX review", "Refunded", "none"]) {
      const response = await GET(new NextRequest(`http://localhost/api/b2c/workspace?issue=${encodeURIComponent(issue)}`));
      expect(response.status).toBe(200);
    }
  });

  it("gives a Viewer the safe ledger page without Stripe evidence and without any work item", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");
    mocks.page.mockResolvedValue(ledgerPage);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.role).toBe("viewer");
    expect(body.workItems).toBeNull();
    expect(body.ledger.rows).toHaveLength(1);
    expect(body.ledger.rows[0].stripeEvidence).toBeUndefined();
    expect(body.ledger.rows[0].decision.reportingDecision).toBe("reportable");
    expect(body.ledger.filterMetadata).toEqual(ledgerPage.filterMetadata);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("gives an Admin the same safe ledger page plus the Work queue overview", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");
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

  it("lets an Admin load a Ledger page without materializing the Work queue", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");
    mocks.page.mockResolvedValue(ledgerPage);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?includeWorkItems=false&cursor=opaque-keyset-token"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.workItems).toBeNull();
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(mocks.page).toHaveBeenCalledWith({ cursor: "opaque-keyset-token" });
  });

  it("returns a validation response for an invalid repository cursor", async () => {
    const { B2cLedgerCursorError } = await import("@/server/repositories/b2c-ledger-repository");
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");
    mocks.page.mockRejectedValue(new B2cLedgerCursorError());

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?cursor=malformed-but-opaque"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "The B2C Ledger page cursor is invalid." });
  });

  it("accepts every exposed ledger filter before it loads the server-filtered page", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");
    mocks.page.mockResolvedValue(ledgerPage);

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace?dateFrom=2026-08-01&dateTo=2026-08-31&foreignCurrencyOnly=true&issue=none&paymentStatus=Refunded"));

    expect(response.status).toBe(200);
    expect(mocks.page).toHaveBeenCalledWith({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      foreignCurrencyOnly: true,
      issue: "none",
      paymentStatus: "Refunded",
    });
  });

  it("returns a safe error without leaking a raw repository failure", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");
    mocks.page.mockRejectedValue(new Error("raw B2C source content"));

    const response = await GET(new NextRequest("http://localhost/api/b2c/workspace"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not load the B2C workspace." });
  });
});

describe("GET /api/b2c/workspace/export", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects an unauthenticated export before reading the Ledger", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");

    const response = await GET_LEDGER_EXPORT(new NextRequest("http://localhost/api/b2c/workspace/export?period=2026-08"));

    expect(response.status).toBe(403);
    expect(mocks.exportRows).not.toHaveBeenCalled();
  });

  it("permanently rejects a Viewer even though the ordinary Ledger is Viewer-readable", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("viewer");

    const response = await GET_LEDGER_EXPORT(new NextRequest("http://localhost/api/b2c/workspace/export?period=2026-08"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
    expect(mocks.exportRows).not.toHaveBeenCalled();
  });

  it("exports the current filters as capped, attachment-safe CSV without provider evidence", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");
    mocks.exportRows.mockResolvedValue({
      rows: [{ ...stripeEvidenceRow, customerName: "=CMD()", issue: "Needs follow-up" }],
      capped: true,
      totalCount: 5_004,
    });

    const response = await GET_LEDGER_EXPORT(new NextRequest("http://localhost/api/b2c/workspace/export?period=2026-08&source=stripe&search=Maya"));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="b2c-ledger-2026-08.csv"');
    expect(response.headers.get("X-Playbook-Export-Capped")).toBe("true");
    expect(response.headers.get("X-Playbook-Export-Row-Count")).toBe("1");
    expect(response.headers.get("X-Playbook-Export-Total-Count")).toBe("5004");
    expect(mocks.exportRows).toHaveBeenCalledWith({ period: "2026-08", source: "stripe", search: "Maya" });
    expect(csv).toContain('"Customer","Email","Mobile","Date","Amount","Source","Status"');
    expect(csv).toContain('"\'=CMD()","maya@example.com","","Aug 1, 2026","$100.00","Stripe","Completed; Needs follow-up"');
    expect(csv).not.toContain("Confidential seller note");
    expect(csv).not.toContain("ch_1");
  });

  it("rejects pagination controls because the server owns export pagination", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");

    const response = await GET_LEDGER_EXPORT(new NextRequest("http://localhost/api/b2c/workspace/export?period=2026-08&limit=100"));

    expect(response.status).toBe(422);
    expect(mocks.exportRows).not.toHaveBeenCalled();
  });

  it("returns a safe export failure without leaking repository details", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: approvedUser } }) } } as never);
    mocks.middlewareRole.mockReturnValue("admin");
    mocks.exportRows.mockRejectedValue(new Error("sensitive source failure"));

    const response = await GET_LEDGER_EXPORT(new NextRequest("http://localhost/api/b2c/workspace/export?period=all"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not export the B2C Ledger." });
  });
});
