import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewRoute } from "@/app/api/admin/b2c/payments/manual-bank-transfer/preview/route";
import { POST as confirmRoute } from "@/app/api/admin/b2c/payments/manual-bank-transfer/route";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { previewManualBankTransfer, recordManualBankTransfer } from "@/server/services/record-manual-bank-transfer";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));
vi.mock("@/server/services/record-manual-bank-transfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/record-manual-bank-transfer")>();
  return { ...actual, previewManualBankTransfer: vi.fn(), recordManualBankTransfer: vi.fn() };
});

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const previewManualBankTransferMock = vi.mocked(previewManualBankTransfer);
const recordManualBankTransferMock = vi.mocked(recordManualBankTransfer);
const adminUserId = "11111111-1111-4111-8111-111111111111";

const validRequest = {
  bankReference: "IBAN-2026-0912",
  customerEmail: "member@playbook.test",
  customerName: "Ada Founder",
  categoryCode: "membership",
  amountUsd: "266",
  receivedAt: "2026-08-12T08:00:00+03:00",
  reason: "New bank transfer received after the latest workbook.",
};

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function mockAdminClient() {
  const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: adminUserId } } }) } };
  createServerClientMock.mockResolvedValue(client as never);
  getApprovedRoleMock.mockResolvedValue("admin");
  return client;
}

describe("Manual bank transfer preview boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("rejects a Viewer before assessing any duplicate", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: adminUserId } } }) } } as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await previewRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer/preview", validRequest));

    expect(response.status).toBe(403);
    expect(previewManualBankTransferMock).not.toHaveBeenCalled();
  });

  it("rejects an incomplete request before calling the service", async () => {
    mockAdminClient();

    const response = await previewRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer/preview", { ...validRequest, bankReference: "" }));

    expect(response.status).toBe(422);
    expect(previewManualBankTransferMock).not.toHaveBeenCalled();
  });

  it("returns the server's duplicate assessment for a valid request", async () => {
    mockAdminClient();
    const assessment = { inputSha256: "a".repeat(64), matchState: "clear" as const, exactMatchHref: null, possibleMatches: [] };
    previewManualBankTransferMock.mockResolvedValue(assessment);

    const response = await previewRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer/preview", validRequest));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assessment });
  });

  it("never surfaces internal error detail from a failed assessment", async () => {
    mockAdminClient();
    previewManualBankTransferMock.mockRejectedValue(new Error("relation missing"));

    const response = await previewRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer/preview", validRequest));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: expect.not.stringContaining("relation") });
  });
});

describe("Manual bank transfer confirmation boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("rejects a Viewer before recording anything", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: adminUserId } } }) } } as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await confirmRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer", { ...validRequest, expectedInputSha256: "a".repeat(64) }));

    expect(response.status).toBe(403);
    expect(recordManualBankTransferMock).not.toHaveBeenCalled();
  });

  it("rejects a confirmation with no reviewed-input hash -- the preview must run first", async () => {
    mockAdminClient();

    const response = await confirmRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer", validRequest));

    expect(response.status).toBe(422);
    expect(recordManualBankTransferMock).not.toHaveBeenCalled();
  });

  it("records the reviewed transfer and returns the created payment", async () => {
    mockAdminClient();
    const createdPayment = { id: "new-payment-1" };
    recordManualBankTransferMock.mockResolvedValue(createdPayment as never);

    const response = await confirmRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer", { ...validRequest, expectedInputSha256: "a".repeat(64) }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ payment: createdPayment });
    expect(recordManualBankTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ ...validRequest, expectedInputSha256: "a".repeat(64) }),
      expect.anything(),
    );
  });

  it("surfaces a specific rejection message for an exact duplicate", async () => {
    mockAdminClient();
    recordManualBankTransferMock.mockRejectedValue(new Error("A manual bank transfer with this reference already exists."));

    const response = await confirmRoute(jsonRequest("http://localhost/api/admin/b2c/payments/manual-bank-transfer", { ...validRequest, expectedInputSha256: "a".repeat(64) }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "A manual bank transfer with this reference already exists." });
  });
});
