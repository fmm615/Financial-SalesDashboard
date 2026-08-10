import type { ReportCoverage, ReportReadiness } from "@/lib/reports/report-data";

/** A report is financial only when every required coverage record is complete. */
export function getReportReadiness(coverage: ReportCoverage[]): ReportReadiness {
  return coverage.length > 0 && coverage.every((entry) => entry.status === "available")
    ? "financial_ready"
    : "draft_fixture_only";
}
