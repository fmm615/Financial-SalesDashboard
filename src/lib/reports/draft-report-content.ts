import type { ReportRequestInput } from "@/lib/validation/financial-contracts";

export type DraftReportContent = {
  title: string;
  periodLabel: string;
  disclaimer: string;
  csv: string;
  pdfLines: string[];
  summarySnapshot: Record<string, string | boolean>;
};

function formatPeriod(periodStart: string, periodEnd: string): string {
  return `${periodStart} to ${periodEnd}`;
}

/**
 * This deliberately contains no provider rows or financial totals. B2C and B2B
 * source data is still under Finance review, so it is unsafe to publish it.
 */
export function createDraftReportContent(request: ReportRequestInput): DraftReportContent {
  const periodLabel = formatPeriod(request.periodStart, request.periodEnd);
  const disclaimer = "DRAFT FIXTURE REPORT — NOT FINANCIAL REPORTING";
  const title = `PLAYBOOK ${request.reportType.replace("_", " ")} report`;
  const csvRows = [
    ["field", "value"],
    ["report_status", "draft_fixture_only"],
    ["period_start", request.periodStart],
    ["period_end", request.periodEnd],
    ["financial_data_included", "false"],
    ["reason", "B2C and B2B source data is pending Finance review"],
  ];

  return {
    title,
    periodLabel,
    disclaimer,
    csv: `${csvRows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n")}\n`,
    pdfLines: [
      "PLAYBOOK Financial Operating System",
      disclaimer,
      title,
      `Period: ${periodLabel}`,
      "",
      "This report validates the archive and download workflow only.",
      "No B2C or B2B source rows, financial totals, targets, or performance",
      "claims are included while Finance resolves incomplete source data.",
    ],
    summarySnapshot: {
      report_status: "draft_fixture_only",
      financial_data_included: false,
      source_data_status: "pending_finance_review",
      period_start: request.periodStart,
      period_end: request.periodEnd,
    },
  };
}
