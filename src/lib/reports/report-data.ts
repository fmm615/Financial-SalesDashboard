import { getReportReadiness } from "@/lib/reports/report-readiness";

export type ReportType = "monthly" | "quarterly" | "annual" | "ad_hoc";
export type ReportCoverageArea = "b2c" | "b2b" | "targets" | "pipeline";
export type ReportCoverageStatus = "available" | "partial" | "not_loaded" | "unavailable";
export type ReportReadiness = "draft_fixture_only" | "financial_ready";

export type ReportCoverage = {
  area: ReportCoverageArea;
  status: ReportCoverageStatus;
  message: string;
};

export type ReportDataSnapshot = {
  version: "1";
  reportType: ReportType;
  periodStart: string;
  periodEnd: string;
  readiness: ReportReadiness;
  financialDataIncluded: boolean;
  coverage: ReportCoverage[];
};

export type DraftReportSnapshotInput = Pick<ReportDataSnapshot, "reportType" | "periodStart" | "periodEnd">;

const draftCoverage: ReportCoverage[] = [
  { area: "b2c", status: "not_loaded", message: "B2C source data is pending Finance review." },
  { area: "b2b", status: "not_loaded", message: "B2B source data is pending Finance review." },
  { area: "targets", status: "not_loaded", message: "Financial targets are not approved for reporting." },
  { area: "pipeline", status: "not_loaded", message: "Pipeline data is not approved for reporting." },
];

/** Creates an explicit non-financial snapshot without reading provider or financial records. */
export function createDraftReportSnapshot(input: DraftReportSnapshotInput): ReportDataSnapshot {
  const coverage = draftCoverage.map((entry) => ({ ...entry }));
  const readiness = getReportReadiness(coverage);
  return {
    version: "1",
    reportType: input.reportType,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    readiness,
    financialDataIncluded: readiness === "financial_ready",
    coverage,
  };
}
