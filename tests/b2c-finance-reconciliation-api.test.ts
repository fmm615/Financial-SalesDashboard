import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewImport } from "@/app/api/admin/b2c/finance-imports/preview/route";
import { POST as finalizeImport } from "@/app/api/admin/b2c/finance-imports/finalize/route";
import { POST as decideGroup } from "@/app/api/admin/b2c/reconciliation/[groupId]/decision/route";
import { GET as getReconciliationSummary } from "@/app/api/b2c/reconciliation/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);

const importRequest = {
  sourceFileName: "payment-tracker.xlsx",
  sourceFileSha256: "a".repeat(64),
  sourceStorageBucket: "b2c-imports",
  sourceStoragePath: "payment-tracker/2026-08-12.xlsx",
  rows: [
    { sourceTab: "B2C", sourceRowNumber: 2, rawPayload: { Name: "Abeer" }, reportedDateRaw: "2026-08-01", amountUsdRaw: "475", customerNameRaw: "Abeer", paymentMethodRaw: "Stripe" },
    { sourceTab: "B2C Cons", sourceRowNumber: 2, rawPayload: { Name: "Abeer" }, reportedDateRaw: "45787", declaredMonth: "October", declaredYear: "2025", amountUsdRaw: "475", customerNameRaw: "Abeer", paymentMethodRaw: "Stripe" },
  ],
};

describe("B2C Finance import APIs", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects an unauthenticated import preview before reading Finance rows", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await previewImport(new NextRequest("http://localhost/api/admin/b2c/finance-imports/preview", {
      method: "POST", body: JSON.stringify(importRequest), headers: { "Content-Type": "application/json" },
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });

  it("returns row-quality counts without writing reportable B2C payments", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await previewImport(new NextRequest("http://localhost/api/admin/b2c/finance-imports/preview", {
      method: "POST", body: JSON.stringify(importRequest), headers: { "Content-Type": "application/json" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ summary: { totalRows: 2, validRows: 1, needsReviewRows: 1, zeroValueRows: 0, invalidRows: 0 } });
  });

  it("finalizes only validated Admin rows through the atomic Finance import function", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, rpc };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await finalizeImport(new NextRequest("http://localhost/api/admin/b2c/finance-imports/finalize", {
      method: "POST", body: JSON.stringify(importRequest), headers: { "Content-Type": "application/json" },
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ importId: "22222222-2222-4222-8222-222222222222" });
    expect(rpc).toHaveBeenCalledWith("finalize_b2c_finance_import", expect.objectContaining({
      p_source_file_sha256: "a".repeat(64),
      p_rows: expect.arrayContaining([expect.objectContaining({ sourceTab: "B2C", rowQuality: "valid" })]),
    }));
  });

  it("rejects a Viewer reconciliation decision before it can write Finance history", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await decideGroup(new NextRequest("http://localhost/api/admin/b2c/reconciliation/22222222-2222-4222-8222-222222222222/decision", {
      method: "POST", body: JSON.stringify({ decisionState: "excluded", decisionReason: "Finance confirmed this is a duplicate." }), headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ groupId: "22222222-2222-4222-8222-222222222222" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });

  it("records only an audited canonical decision for a valid reconciliation group", async () => {
    const insert = vi.fn().mockReturnValue({ select: () => ({ single: vi.fn().mockResolvedValue({ data: { id: "33333333-3333-4333-8333-333333333333" }, error: null }) }) });
    const client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) },
      from: vi.fn().mockReturnValue({ insert }),
    };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await decideGroup(new NextRequest("http://localhost/api/admin/b2c/reconciliation/22222222-2222-4222-8222-222222222222/decision", {
      method: "POST", body: JSON.stringify({ decisionState: "canonical", canonicalFinanceRowId: "44444444-4444-4444-8444-444444444444", decisionReason: "Finance verified the source row against the workbook." }), headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ groupId: "22222222-2222-4222-8222-222222222222" }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ decisionId: "33333333-3333-4333-8333-333333333333" });
    expect(insert).toHaveBeenCalledWith({
      reconciliation_group_id: "22222222-2222-4222-8222-222222222222",
      decision_state: "canonical",
      canonical_finance_row_id: "44444444-4444-4444-8444-444444444444",
      decision_reason: "Finance verified the source row against the workbook.",
    });
  });

  it("returns only safe summary data to an approved Viewer", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      publicationState: "not_fully_loaded",
      publicationMessage: "B2C Finance revenue is withheld.",
      sources: [],
      counts: { stagedRows: 0, validRows: 0, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0, unresolvedGroups: 0 },
    }, error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, rpc };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await getReconciliationSummary();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ summary: { publicationState: "not_fully_loaded", counts: { stagedRows: 0 } } });
    expect(rpc).toHaveBeenCalledWith("get_b2c_reconciliation_safe_summary", {});
  });
});
