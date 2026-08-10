import type { ReportCoverage, ReportDataSnapshot } from "@/lib/reports/report-data";

export type DraftReportSummarySnapshot = {
  readiness: ReportDataSnapshot["readiness"];
  version: ReportDataSnapshot["version"];
  financial_data_included: boolean;
  period_start: string;
  period_end: string;
  coverage: ReportCoverage[];
};

export type DraftReportContent = {
  title: string;
  periodLabel: string;
  disclaimer: string;
  csv: string;
  pdfLines: string[];
  summarySnapshot: DraftReportSummarySnapshot;
};

function formatPeriod(periodStart: string, periodEnd: string): string {
  return `${periodStart} to ${periodEnd}`;
}

function formatCoverageArea(area: ReportCoverage["area"]): string {
  return area.toUpperCase();
}

function formatCoverageStatus(status: ReportCoverage["status"]): string {
  return status.replaceAll("_", " ");
}

function quoteCsvValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * This deliberately contains no provider rows or financial totals. B2C and B2B
 * source data is still under Finance review, so it is unsafe to publish it.
 */
export function createDraftReportContent(snapshot: ReportDataSnapshot): DraftReportContent {
  const periodLabel = formatPeriod(snapshot.periodStart, snapshot.periodEnd);
  const disclaimer = "DRAFT FIXTURE REPORT — NOT FINANCIAL REPORTING";
  const title = `PLAYBOOK ${snapshot.reportType.replace("_", " ")} report`;
  const csvRows = [
    ["field", "value"],
    ["readiness", snapshot.readiness],
    ["snapshot_version", snapshot.version],
    ["period_start", snapshot.periodStart],
    ["period_end", snapshot.periodEnd],
    ["financial_data_included", String(snapshot.financialDataIncluded)],
    ...snapshot.coverage.map((coverage) => [`coverage_${coverage.area}_status`, coverage.status]),
    ...snapshot.coverage.map((coverage) => [`coverage_${coverage.area}_message`, coverage.message]),
  ];
  const coverageLines = snapshot.coverage.map(
    (coverage) => `${formatCoverageArea(coverage.area)}: ${formatCoverageStatus(coverage.status)} — ${coverage.message}`,
  );

  return {
    title,
    periodLabel,
    disclaimer,
    csv: `${csvRows.map((row) => row.map(quoteCsvValue).join(",")).join("\n")}\n`,
    pdfLines: [
      "PLAYBOOK Financial Operating System",
      disclaimer,
      title,
      `Period: ${periodLabel}`,
      "",
      "This report validates the archive and download workflow only.",
      "No B2C or B2B source rows, financial totals, targets, or performance",
      "claims are included while Finance resolves incomplete source data.",
      "",
      "Coverage:",
      ...coverageLines,
    ],
    summarySnapshot: {
      readiness: snapshot.readiness,
      version: snapshot.version,
      financial_data_included: snapshot.financialDataIncluded,
      period_start: snapshot.periodStart,
      period_end: snapshot.periodEnd,
      coverage: snapshot.coverage.map((coverage) => ({ ...coverage })),
    },
  };
}
