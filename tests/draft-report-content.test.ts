import { describe, expect, it } from "vitest";
import { createDraftReportContent } from "@/lib/reports/draft-report-content";
import { createSimplePdf } from "@/lib/reports/simple-pdf";

describe("draft report content", () => {
  it("is explicitly non-financial while provider data is under review", () => {
    const content = createDraftReportContent({ reportType: "ad_hoc", periodStart: "2026-08-01", periodEnd: "2026-08-10", deliveryRequested: false });
    expect(content.summarySnapshot).toMatchObject({ report_status: "draft_fixture_only", financial_data_included: false });
    expect(content.csv).toContain("B2C and B2B source data is pending Finance review");
    expect(content.pdfLines.join(" ")).toContain("NOT FINANCIAL REPORTING");
  });

  it("creates a valid PDF payload", () => {
    const pdf = new TextDecoder().decode(createSimplePdf(["PLAYBOOK", "Draft"]));
    expect(pdf).toContain("%PDF-1.4");
    expect(pdf).toContain("%%EOF");
  });
});
