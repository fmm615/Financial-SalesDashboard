import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewRoute } from "@/app/api/admin/b2c/tap-statement/preview/route";
import { POST as finalizeRoute } from "@/app/api/admin/b2c/tap-statement/finalize/route";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizeTapStatementUpload } from "@/server/services/tap-statement-upload";
import { parseTapStatementCsv } from "@/server/services/tap-statement-csv";
import { linkB2cProviderEvidenceExactMatches } from "@/server/services/b2c-provider-evidence-reconciliation";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));
vi.mock("@/server/services/tap-statement-csv", () => ({ parseTapStatementCsv: vi.fn() }));
vi.mock("@/server/services/b2c-provider-evidence-reconciliation", () => ({ linkB2cProviderEvidenceExactMatches: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const parseTapCsvMock = vi.mocked(parseTapStatementCsv);
const linkB2cProviderEvidenceExactMatchesMock = vi.mocked(linkB2cProviderEvidenceExactMatches);
const fileHash = "c".repeat(64);

if (!("arrayBuffer" in File.prototype)) Object.defineProperty(File.prototype, "arrayBuffer", { value: async () => new TextEncoder().encode("tap test bytes").buffer });

const parsedStatement = {
  sourceFileName: "Tap Statement.csv",
  sourceFileSha256: fileHash,
  rows: [
    { sourceRowNumber: 2, postingId: "111", paymentId: "chg_111", refundId: null, kind: "sale" as const, description: "Sale - Fatima", occurredAt: null, occurredAtRaw: "02/01/24 11:33 AM", currency: "BHD", credit: "74.570", debit: null, rawPayload: { posting_id: "111" } },
    { sourceRowNumber: 3, postingId: "112", paymentId: "chg_111", refundId: null, kind: "processing_fee" as const, description: "Fee - Transaction Processing", occurredAt: null, occurredAtRaw: "02/01/24 11:33 AM", currency: "BHD", credit: null, debit: "2.524", rawPayload: { posting_id: "112" } },
  ],
};

function requestWithFile(url: string, expectedFileSha256?: string): NextRequest {
  const form = new FormData();
  form.set("file", new File(["tap test bytes"], "Tap Statement.csv", { type: "text/csv" }));
  if (expectedFileSha256) form.set("expectedFileSha256", expectedFileSha256);
  const request = new NextRequest(url, { method: "POST" });
  vi.spyOn(request, "formData").mockResolvedValue(form);
  return request;
}

describe("Tap statement upload boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); parseTapCsvMock.mockReturnValue(parsedStatement); linkB2cProviderEvidenceExactMatchesMock.mockResolvedValue({ exactMatches: [], mismatches: [], unmatchedEvidence: [] }); });

  it("rejects a Viewer before parsing their Tap CSV", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/tap-statement/preview"));

    expect(response.status).toBe(403);
    expect(parseTapCsvMock).not.toHaveBeenCalled();
  });

  it("returns safe Tap classification counts without writing Storage or database evidence", async () => {
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/tap-statement/preview"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ preview: { sourceFileSha256: fileHash, totalRows: 2, kindCounts: { sale: 1, processing_fee: 1 }, unparsedDates: 2 } });
    expect("storage" in client).toBe(false);
    expect("rpc" in client).toBe(false);
  });

  it("rejects confirmation when the file differs from its preview", async () => {
    const upload = vi.fn();
    await expect(finalizeTapStatementUpload({ storage: { from: vi.fn().mockReturnValue({ upload }) } } as never, new File(["bytes"], "Tap Statement.csv"), "d".repeat(64))).rejects.toThrow(/changed.*preview/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("removes the private Tap source when atomic evidence staging fails", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const client = { storage: { from: vi.fn().mockReturnValue({ upload, remove }) }, rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "failure" } }) };

    await expect(finalizeTapStatementUpload(client as never, new File(["bytes"], "Tap Statement.csv"), fileHash)).rejects.toThrow(/could not be staged/i);
    expect(remove).toHaveBeenCalledWith([expect.stringMatching(/^tap-statement\/[a-f0-9]{64}\/.+\.csv$/)]);
  });

  it("stages a matching Admin file through private Storage and the atomic Tap RPC", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, storage: { from: vi.fn().mockReturnValue({ upload }) }, rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }) };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/tap-statement/finalize", fileHash));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ importId: "22222222-2222-4222-8222-222222222222" });
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^tap-statement\/[a-f0-9]{64}\/.+\.csv$/), expect.any(Uint8Array), expect.objectContaining({ contentType: "text/csv", upsert: false }));
    expect(client.rpc).toHaveBeenCalledWith("finalize_tap_statement_import", expect.objectContaining({ p_source_file_sha256: fileHash, p_rows: expect.any(Array) }));
  });

  it("reconciles exact Tap provider-ID evidence after a successful import", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, storage: { from: vi.fn().mockReturnValue({ upload }) }, rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }) };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/tap-statement/finalize", fileHash));

    expect(linkB2cProviderEvidenceExactMatchesMock).toHaveBeenCalledWith(client, { importId: "22222222-2222-4222-8222-222222222222", provider: "tap" });
  });

  it("never fails a successful import when evidence reconciliation itself fails", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) }, storage: { from: vi.fn().mockReturnValue({ upload }) }, rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }) };
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");
    linkB2cProviderEvidenceExactMatchesMock.mockRejectedValue(new Error("evidence link failure"));

    const response = await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/tap-statement/finalize", fileHash));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ importId: "22222222-2222-4222-8222-222222222222" });
  });
});
