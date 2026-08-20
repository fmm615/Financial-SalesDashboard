import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cPaymentTrackerUpload } from "@/features/b2c/b2c-payment-tracker-upload";

afterEach(() => vi.unstubAllGlobals());

const preview = {
  sourceFileSha256: "a".repeat(64),
  acceptedTabs: ["B2C", "B2C Cons"] as const,
  summary: { totalRows: 3, validRows: 3, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0 },
  issueCounts: {},
  duplicateCandidates: { exact: 0, possible: 0, conflicts: 0 },
  methodSummary: { iosRows: 1, bankTransferRows: 2, unsupportedRows: 0 },
  versionDiff: { unchangedCount: 0, newCount: 3, removedCount: 0, ambiguousCount: 0, existingPaymentCount: 0 },
};

function selectFile() {
  const input = screen.getByLabelText(/workbook/i) as HTMLInputElement;
  const file = new File(["binary"], "tracker.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("B2cPaymentTrackerUpload replacement intent", () => {
  it("omits supersedesImportId from the preview and finalize requests for the first-ever import", async () => {
    const calls: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push(init?.body as FormData);
      if (String(input).includes("/preview")) return { ok: true, json: async () => ({ preview }) } as Response;
      return { ok: true, json: async () => ({ importId: "import-1" }) } as Response;
    }));

    render(<B2cPaymentTrackerUpload hasExistingImport={false} supersedesImportId={null} onImported={() => undefined} />);
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/3 extracted rows/);
    fireEvent.click(screen.getByRole("button", { name: "Import reviewed workbook" }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[0].get("supersedesImportId")).toBeNull();
    expect(calls[1].get("supersedesImportId")).toBeNull();
  });

  it("declares supersedesImportId on both the preview and finalize requests when replacing a completed import", async () => {
    const calls: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push(init?.body as FormData);
      if (String(input).includes("/preview")) return { ok: true, json: async () => ({ preview }) } as Response;
      return { ok: true, json: async () => ({ importId: "import-2" }) } as Response;
    }));

    render(<B2cPaymentTrackerUpload hasExistingImport={true} supersedesImportId="prior-import-1" onImported={() => undefined} />);
    expect(screen.getByLabelText(/workbook/i)).toHaveAccessibleName("Replace workbook");
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/3 extracted rows/);
    fireEvent.click(screen.getByRole("button", { name: "Replace with reviewed workbook" }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[0].get("supersedesImportId")).toBe("prior-import-1");
    expect(calls[1].get("supersedesImportId")).toBe("prior-import-1");
  });
});
