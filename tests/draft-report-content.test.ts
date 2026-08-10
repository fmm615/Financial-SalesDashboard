import { describe, expect, it } from "vitest";
import { createDraftReportContent } from "@/lib/reports/draft-report-content";
import { createDraftReportSnapshot } from "@/lib/reports/report-data";
import { createSimplePdf } from "@/lib/reports/simple-pdf";

describe("draft report content", () => {
  it("is explicitly non-financial while provider data is under review", () => {
    const content = createDraftReportContent(createDraftReportSnapshot({
      reportType: "ad_hoc",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-10",
    }));

    expect(content.summarySnapshot).toMatchObject({ readiness: "draft_fixture_only", financial_data_included: false });
    expect(content.csv).toContain("B2C source data is pending Finance review.");
    expect(content.pdfLines.join(" ")).toContain("NOT FINANCIAL REPORTING");
  });

  it("creates a valid PDF payload", () => {
    const pdf = new TextDecoder().decode(createSimplePdf(["PLAYBOOK", "Draft"]));
    expect(pdf).toContain("%PDF-1.4");
    expect(pdf).toContain("%%EOF");
  });

  it("carries the snapshot readiness disclosure across every draft artifact", () => {
    const snapshot = createDraftReportSnapshot({
      reportType: "monthly",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });

    const content = createDraftReportContent(snapshot);

    expect(content.csv).toContain("draft_fixture_only");
    expect(content.csv).toContain("B2C source data is pending Finance review.");
    expect(content.pdfLines.join(" ")).toContain("NOT FINANCIAL REPORTING");
    expect(content.pdfLines.join(" ")).toContain("B2C: not loaded — B2C source data is pending Finance review.");
    expect(content.summarySnapshot).toMatchObject({
      readiness: "draft_fixture_only",
      version: "1",
      period_start: "2026-08-01",
      period_end: "2026-08-31",
    });
  });
});
