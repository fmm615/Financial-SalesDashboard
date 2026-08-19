import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewRoute } from "@/app/api/admin/b2c/payment-tracker/preview/route";
import { POST as finalizeRoute } from "@/app/api/admin/b2c/payment-tracker/finalize/route";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizePaymentTrackerUpload, PaymentTrackerUploadError, previewPaymentTrackerUpload } from "@/server/services/payment-tracker-upload";
import { parsePaymentTrackerWorkbook } from "@/server/services/payment-tracker-workbook";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));
vi.mock("@/server/services/payment-tracker-workbook", () => ({ parsePaymentTrackerWorkbook: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const parseWorkbookMock = vi.mocked(parsePaymentTrackerWorkbook);
const fileHash = "a".repeat(64);

// JSDOM's File lacks arrayBuffer(), unlike the File supplied by Next.js routes.
if (!("arrayBuffer" in File.prototype)) {
  Object.defineProperty(File.prototype, "arrayBuffer", {
    value: async () => new TextEncoder().encode("safe test bytes").buffer,
  });
}
const parsedWorkbook = {
  sourceFileName: "Payment Tracker.xlsx",
  sourceFileSha256: fileHash,
  acceptedTabs: ["B2C", "B2C Cons"] as ["B2C", "B2C Cons"],
  rows: [
    { sourceTab: "B2C" as const, sourceRowNumber: 2, reportedDateRaw: "2025-10-05", amountUsdRaw: "475", customerNameRaw: "Reham", paymentMethodRaw: "Stripe", rawPayload: { Name: "Reham" } },
    { sourceTab: "B2C Cons" as const, sourceRowNumber: 2, reportedDateRaw: "2025-10-05", amountUsdRaw: "475", customerNameRaw: "Reham", paymentMethodRaw: "Stripe", rawPayload: { Name: "Reham" } },
  ],
};

function requestWithFile(url: string, expectedFileSha256?: string, supersedesImportId?: string): NextRequest {
  const form = new FormData();
  form.set("file", new File(["safe test bytes"], "Payment Tracker.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  if (expectedFileSha256) form.set("expectedFileSha256", expectedFileSha256);
  if (supersedesImportId) form.set("supersedesImportId", supersedesImportId);
  const request = new NextRequest(url, { method: "POST" });
  vi.spyOn(request, "formData").mockResolvedValue(form);
  return request;
}

/** The version-diff query the service always runs, resolved as if no prior state exists. */
function withEmptyVersionState<T extends object>(client: T): T & { from: ReturnType<typeof vi.fn> } {
  const from = vi.fn((table: string) => {
    if (table === "b2c_finance_staging_rows") return { select: () => ({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) };
    if (table === "b2c_finance_row_lineage_links") return { select: () => ({ in: vi.fn().mockResolvedValue({ data: [], error: null }) }) };
    if (table === "b2c_finance_record_lineages") return { select: () => ({ not: vi.fn().mockResolvedValue({ data: [], error: null }) }) };
    throw new Error(`Unexpected table in test: ${table}`);
  });
  return { ...client, from };
}

describe("Payment Tracker upload boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    parseWorkbookMock.mockResolvedValue(parsedWorkbook);
  });

  it("rejects a Viewer before parsing a multipart workbook", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } } as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/payment-tracker/preview"));

    expect(response.status).toBe(403);
    expect(parseWorkbookMock).not.toHaveBeenCalled();
  });

  it("returns a safe preview without Storage or an import RPC", async () => {
    const client = withEmptyVersionState({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) } });
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/payment-tracker/preview"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preview: {
        sourceFileSha256: fileHash,
        summary: { totalRows: 2 },
        // The fixture's two rows (B2C and B2C Cons) share one customer/date/amount/method identity,
        // so they hold each other as ambiguous rather than each becoming an independent new candidate.
        versionDiff: { unchangedCount: 0, newCount: 0, removedCount: 0, ambiguousCount: 2, existingPaymentCount: 0 },
      },
    });
    expect("storage" in client).toBe(false);
    expect("rpc" in client).toBe(false);
  });

  it("finds a possible duplicate even when the workbook rows are not date-sorted", async () => {
    parseWorkbookMock.mockResolvedValue({
      ...parsedWorkbook,
      rows: [
        { ...parsedWorkbook.rows[0], reportedDateRaw: "2025-10-07" },
        { ...parsedWorkbook.rows[1], reportedDateRaw: "2025-10-05" },
      ],
    });
    const client = withEmptyVersionState({});

    await expect(previewPaymentTrackerUpload(client as never, new File(["bytes"], "Payment Tracker.xlsx"), null)).resolves.toMatchObject({
      duplicateCandidates: { exact: 0, possible: 1, conflicts: 0 },
    });
  });

  it("rejects confirmation when its source hash differs from the reviewed preview", async () => {
    const upload = vi.fn();
    const client = { storage: { from: vi.fn().mockReturnValue({ upload }) } };

    await expect(finalizePaymentTrackerUpload(client as never, new File(["bytes"], "Payment Tracker.xlsx"), "b".repeat(64), null)).rejects.toThrow(/changed.*preview/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("removes a private source file when atomic Finance staging fails", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const client = withEmptyVersionState({
      storage: { from: vi.fn().mockReturnValue({ upload, remove }) },
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "database failure" } }),
    });

    await expect(finalizePaymentTrackerUpload(client as never, new File(["bytes"], "Payment Tracker.xlsx"), fileHash, null)).rejects.toThrow(/could not be staged/i);
    expect(remove).toHaveBeenCalledWith([expect.stringMatching(/^payment-tracker\/[a-f0-9]{64}\/.+\.xlsx$/)]);
  });

  it("stages a matching Admin workbook only through private Storage and the atomic import version RPC", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = withEmptyVersionState({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) },
      storage: { from: vi.fn().mockReturnValue({ upload }) },
      rpc: vi.fn().mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null }),
    });
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/payment-tracker/finalize", fileHash));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ importId: "22222222-2222-4222-8222-222222222222" });
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^payment-tracker\/[a-f0-9]{64}\/.+\.xlsx$/), expect.any(Uint8Array), expect.objectContaining({ upsert: false }));
    expect(client.rpc).toHaveBeenCalledWith("finalize_b2c_finance_import_version", expect.objectContaining({
      p_source_file_sha256: fileHash,
      p_supersedes_import_id: null,
      p_rows: expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) })]),
    }));
  });

  it("stages the first-ever Payment Tracker import without declaring a superseded import", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = withEmptyVersionState({
      storage: { from: vi.fn().mockReturnValue({ upload }) },
      rpc: vi.fn().mockResolvedValue({ data: "66666666-6666-4666-8666-666666666666", error: null }),
    });

    await expect(finalizePaymentTrackerUpload(client as never, new File(["bytes"], "Payment Tracker.xlsx"), fileHash, null))
      .resolves.toBe("66666666-6666-4666-8666-666666666666");
    expect(client.rpc).toHaveBeenCalledWith("finalize_b2c_finance_import_version", expect.objectContaining({ p_supersedes_import_id: null }));
  });

  it("surfaces the database's replacement-intent rejection as a Payment Tracker staging failure", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const client = withEmptyVersionState({
      storage: { from: vi.fn().mockReturnValue({ upload, remove }) },
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "A replacement Payment Tracker import must declare the completed import it supersedes" } }),
    });

    await expect(finalizePaymentTrackerUpload(client as never, new File(["bytes"], "Payment Tracker.xlsx"), fileHash, null))
      .rejects.toBeInstanceOf(PaymentTrackerUploadError);
    expect(remove).toHaveBeenCalledWith([expect.stringMatching(/^payment-tracker\/[a-f0-9]{64}\/.+\.xlsx$/)]);
  });

  it("passes a declared superseded import id through to preview and finalization", async () => {
    const supersedesImportId = "77777777-7777-4777-8777-777777777777";
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = withEmptyVersionState({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) },
      storage: { from: vi.fn().mockReturnValue({ upload }) },
      rpc: vi.fn().mockResolvedValue({ data: "88888888-8888-4888-8888-888888888888", error: null }),
    });
    createServerClientMock.mockResolvedValue(client as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const previewResponse = await previewRoute(requestWithFile("http://localhost/api/admin/b2c/payment-tracker/preview", undefined, supersedesImportId));
    expect(previewResponse.status).toBe(200);
    expect(client.from).toHaveBeenCalledWith("b2c_finance_staging_rows");

    const finalizeResponse = await finalizeRoute(requestWithFile("http://localhost/api/admin/b2c/payment-tracker/finalize", fileHash, supersedesImportId));
    expect(finalizeResponse.status).toBe(201);
    expect(client.rpc).toHaveBeenCalledWith("finalize_b2c_finance_import_version", expect.objectContaining({ p_supersedes_import_id: supersedesImportId }));
  });
});
