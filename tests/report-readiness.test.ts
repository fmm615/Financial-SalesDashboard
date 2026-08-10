import { describe, expect, it } from "vitest";
import { createDraftReportSnapshot } from "@/lib/reports/report-data";
import { getReportReadiness } from "@/lib/reports/report-readiness";

describe("report readiness", () => {
  it("marks a report financially ready only when every required coverage area is available", () => {
    expect(getReportReadiness([
      { area: "b2c", status: "available", message: "B2C source history is ready." },
      { area: "b2b", status: "available", message: "B2B source history is ready." },
    ])).toBe("financial_ready");
  });

  it("keeps a report draft when any required coverage area is incomplete", () => {
    expect(getReportReadiness([
      { area: "b2c", status: "available", message: "B2C source history is ready." },
      { area: "b2b", status: "partial", message: "B2B backfill is incomplete." },
    ])).toBe("draft_fixture_only");
  });

  it("creates a draft snapshot with explicit non-financial coverage disclosures", () => {
    const snapshot = createDraftReportSnapshot({ reportType: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31" });

    expect(snapshot).toMatchObject({ version: "1", readiness: "draft_fixture_only", financialDataIncluded: false });
    expect(snapshot.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: "b2c", status: "not_loaded" }),
      expect.objectContaining({ area: "b2b", status: "not_loaded" }),
      expect.objectContaining({ area: "targets", status: "not_loaded" }),
      expect.objectContaining({ area: "pipeline", status: "not_loaded" }),
    ]));
  });
});
