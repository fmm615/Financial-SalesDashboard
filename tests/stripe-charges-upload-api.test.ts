import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewRoute } from "@/app/api/admin/b2c/stripe-charges/preview/route";
import { POST as finalizeRoute } from "@/app/api/admin/b2c/stripe-charges/finalize/route";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizeStripeChargesUpload } from "@/server/services/stripe-charges-upload";
import { parseStripeChargesCsv } from "@/server/services/stripe-charges-csv";
import { linkB2cProviderEvidenceExactMatches } from "@/server/services/b2c-provider-evidence-reconciliation";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));
vi.mock("@/server/services/stripe-charges-csv", () => ({ parseStripeChargesCsv: vi.fn() }));
vi.mock("@/server/services/b2c-provider-evidence-reconciliation", () => ({ linkB2cProviderEvidenceExactMatches: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const parseStripeChargesCsvMock = vi.mocked(parseStripeChargesCsv);
const linkB2cProviderEvidenceExactMatchesMock = vi.mocked(linkB2cProviderEvidenceExactMatches);
const fileHash = "d".repeat(64);

if (!("arrayBuffer" in File.prototype)) Object.defineProperty(File.prototype, "arrayBuffer", { value: async () => new TextEncoder().encode("stripe test bytes").buffer });

const parsedCharges = {
  sourceFileName: "Stripe Charges.csv",
  sourceFileSha256: fileHash,
  rows: [
    { sourceRowNumber: 2, sourceEntryKey: "primary" as const, chargeId: "ch_paid", kind: "sale" as const, description: "Membership", occurredAt: "2026-08-09T09:37:33.000Z", occurredAtRaw: "2026-08-09 09:37:33", currency: "USD", credit: "50.42", debit: null, customerName: "Ada Founder", customerEmail: "ada@example.com", customerPhone: "+973 1700 0000", rawPayload: { status: "Paid" } },
    { sourceRowNumber: 3, sourceEntryKey: "primary" as const, chargeId: "ch_refunded", kind: "sale" as const, description: "Membership", occurredAt: "2026-08-08T17:52:15.000Z", occurredAtRaw: "2026-08-08 17:52:15", currency: "USD", credit: "50.42", debit: null, customerName: "Refunded Member", customerEmail: "refund@example.com", customerPhone: null, rawPayload: { status: "Refunded" } },
    { sourceRowNumber: 3, sourceEntryKey: "refund" as const, chargeId: "ch_refunded", kind: "refund" as const, description: "Membership", occurredAt: "2026-08-10T06:51:47.000Z", occurredAtRaw: "2026-08-10 06:51:47", currency: "USD", credit: null, debit: "50.42", customerName: "Refunded Member", customerEmail: "refund@example.com", customerPhone: null, rawPayload: { status: "Refunded" } },
    { sourceRowNumber: 4, sourceEntryKey: "primary" as const, chargeId: "ch_failed", kind: "needs_review" as const, description: "Membership", occurredAt: "2026-08-07T14:02:13.000Z", occurredAtRaw: "2026-08-07 14:02:13", currency: "GBP", credit: "453.75", debit: null, customerName: null, customerEmail: null, customerPhone: null, rawPayload: { status: "Failed" } },
  ],
};

function requestWithFile(url: string, expectedFileSha256?: string): NextRequest {
  const form = new FormData();
  form.set("file", new File(["stripe test bytes"], "Stripe Charges.csv", { type: "text/csv" }));
  if (expectedFileSha256) form.set("expectedFileSha256", expectedFileSha256);
  const request = new NextRequest(url, { method: "POST" });
  vi.spyOn(request, "formData").mockResolvedValue(form);
  return request;
}

describe("Stripe Charges upload boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); parseStripeChargesCsvMock.mockReturnValue(parsedCharges); linkB2cProviderEvidenceExactMatchesMock.mockResolvedValue({ exactMatches: [], mismatches: [], unmatchedEvidence: [] }); });

  it("rejects a Viewer before parsing their Stripe CSV", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/stripe-charges/preview"));

    expect(response.status).toBe(403);
    expect(parseStripeChargesCsvMock).not.toHaveBeenCalled();
  });

  it("returns only safe Stripe evidence counts during preview", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/stripe-charges/preview"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview: { sourceFileSha256: fileHash, sourceRows: 3, evidenceEntries: 4, saleEntries: 2, refundEntries: 1, needsReviewEntries: 1, rowsWithContact: 2, nonUsdSaleEntries: 0 } });
    expect("storage" in client).toBe(false);
    expect("rpc" in client).toBe(false);
  });

  it("does not store a source file when confirmation differs from its preview", async () => {
    const upload = vi.fn();

    await expect(finalizeStripeChargesUpload({ storage: { from: vi.fn().mockReturnValue({ upload }) } } as never, new File(["bytes"], "Stripe Charges.csv"), "e".repeat(64))).rejects.toThrow(/changed.*preview/i);

    expect(upload).not.toHaveBeenCalled();
  });

  it("removes private source bytes when atomic Stripe staging fails", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const client = { storage: { from: vi.fn().mockReturnValue({ upload, remove }) }, rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "failure" } }) };

    await expect(finalizeStripeChargesUpload(client as never, new File(["bytes"], "Stripe Charges.csv"), fileHash)).rejects.toThrow(/could not be staged/i);

    expect(remove).toHaveBeenCalledWith([expect.stringMatching(/^stripe-charges\/[a-f0-9]{64}\/.+\.csv$/)]);
  });

  it("stages a matching Admin file through private Storage and the atomic RPC", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, storage: { from: vi.fn().mockReturnValue({ upload }) }, rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }) };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/stripe-charges/finalize", fileHash));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ importId: "22222222-2222-4222-8222-222222222222" });
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^stripe-charges\/[a-f0-9]{64}\/.+\.csv$/), expect.any(Uint8Array), expect.objectContaining({ contentType: "text/csv", upsert: false }));
    expect(client.rpc).toHaveBeenCalledWith("finalize_stripe_charges_import", expect.objectContaining({ p_source_file_sha256: fileHash, p_rows: expect.any(Array) }));
  });

  it("reconciles exact Stripe provider-ID evidence after a successful import", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, storage: { from: vi.fn().mockReturnValue({ upload }) }, rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }) };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/stripe-charges/finalize", fileHash));

    expect(linkB2cProviderEvidenceExactMatchesMock).toHaveBeenCalledWith(client, { importId: "22222222-2222-4222-8222-222222222222", provider: "stripe" });
  });

  it("never fails a successful import when evidence reconciliation itself fails", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, storage: { from: vi.fn().mockReturnValue({ upload }) }, rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }) };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");
    linkB2cProviderEvidenceExactMatchesMock.mockRejectedValue(new Error("evidence link failure"));

    const response = await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/stripe-charges/finalize", fileHash));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ importId: "22222222-2222-4222-8222-222222222222" });
  });
});
