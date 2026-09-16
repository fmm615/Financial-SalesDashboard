"use client";

import { useState, type ChangeEvent } from "react";
import { B2cPeriodSelector } from "@/features/b2c/b2c-period-selector";
import { useCanManage } from "@/lib/auth/role-context";

export type B2cLedgerFiltersState = {
  search: string;
  dateFrom: string;
  dateTo: string;
  minAmount: string;
  maxAmount: string;
  status: string;
  source: string;
  issue: string;
  financeStatus: string;
  foreignCurrencyOnly: boolean;
};

export const initialB2cLedgerFilters: B2cLedgerFiltersState = {
  search: "", dateFrom: "", dateTo: "", minAmount: "", maxAmount: "", status: "all", source: "all", issue: "all", financeStatus: "all", foreignCurrencyOnly: false,
};

type Option = { value: string; label: string };

/** Mirrors the `reportingDecision` enum the server already validates and filters on -- see b2cWorkspaceLedgerQuerySchema. */
const FINANCE_STATUS_OPTIONS: Option[] = [
  { value: "reportable", label: "Included — reportable" },
  { value: "exception_included", label: "Included — Finance exception" },
  { value: "blocked", label: "Excluded — needs correction" },
  { value: "excluded", label: "Excluded — duplicate" },
];

/** Display-only controls for narrowing the already-loaded B2C source ledger. */
export function B2cLedgerFilters({ filters, onChange, periodMonth, sources, issues, shownCount, totalCount, foreignCurrencyCount, exportHref }: {
  filters: B2cLedgerFiltersState;
  onChange: (filters: B2cLedgerFiltersState) => void;
  periodMonth: string;
  sources: Option[];
  issues: Option[];
  shownCount: number;
  totalCount: number;
  foreignCurrencyCount: number;
  exportHref: string;
}) {
  const canManage = useCanManage();
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{ href: string; kind: "success" | "error"; message: string } | null>(null);

  function update(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    onChange({ ...filters, [event.target.name]: event.target.value });
  }

  async function exportCsv() {
    setExporting(true);
    setExportFeedback(null);
    try {
      const response = await fetch(exportHref, { cache: "no-store" });
      if (!response.ok) throw new Error("The filtered Ledger could not be exported.");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? `b2c-ledger-${periodMonth}.csv`;
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);

      const rowCount = response.headers.get("X-Playbook-Export-Row-Count") ?? "0";
      const capped = response.headers.get("X-Playbook-Export-Capped") === "true";
      setExportFeedback({
        href: exportHref,
        kind: "success",
        message: capped
          ? `Exported the first ${Number(rowCount).toLocaleString()} matching records. Narrow the filters to export records beyond the 5,000-row cap.`
          : `Exported ${Number(rowCount).toLocaleString()} matching records.`,
      });
    } catch {
      setExportFeedback({ href: exportHref, kind: "error", message: "The filtered Ledger could not be exported. Please try again." });
    } finally {
      setExporting(false);
    }
  }
  const inputClass = "mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
  const hasFilters = Object.entries(filters).some(([key, value]) => {
    if (key === "foreignCurrencyOnly") return value === true;
    return key === "status" || key === "source" || key === "issue" || key === "financeStatus" ? value !== "all" : value !== "";
  });
  // Advanced filters live under "More filters"; the badge counts only those, so
  // an Admin can tell at a glance whether a hidden filter is narrowing the ledger.
  const advancedFilterCount = [
    filters.dateFrom !== "",
    filters.dateTo !== "",
    filters.minAmount !== "",
    filters.maxAmount !== "",
    filters.foreignCurrencyOnly,
  ].filter(Boolean).length;
  return <div role="region" aria-label="B2C ledger filters" className="mb-5 rounded-input border border-border bg-surface-muted/30 p-4">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <div><span className="text-sm text-text-primary">Reporting period</span><div className="mt-1 flex h-10 items-center"><B2cPeriodSelector month={periodMonth} /></div></div>
      <label>Search<input name="search" value={filters.search} onChange={update} className={inputClass} placeholder="Name, email, mobile, or ID" /></label>
      <label>Source<select name="source" value={filters.source} onChange={update} className={inputClass}><option value="all">All sources</option>{sources.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label>
      <label>Payment status<select name="status" value={filters.status} onChange={update} className={inputClass}><option value="all">All statuses</option><option value="Completed">Completed</option><option value="Failed">Failed</option><option value="Pending">Pending</option><option value="Refunded">Refunded</option></select></label>
      <label>Issue<select name="issue" value={filters.issue} onChange={update} className={inputClass}><option value="all">All issues</option><option value="none">No issue</option>{issues.map((issue) => <option key={issue.value} value={issue.value}>{issue.label}</option>)}</select></label>
      <label>Finance status<select name="financeStatus" value={filters.financeStatus} onChange={update} className={inputClass}><option value="all">All records</option>{FINANCE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div>
    <details className="mt-4 group">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-brand-accent marker:content-none">
        <span>More filters</span>
        {advancedFilterCount > 0 && <span className="rounded-pill bg-brand-accent/10 px-2 py-0.5 text-xs font-semibold text-brand-accent">{advancedFilterCount}</span>}
        <span className="text-xs font-normal text-text-muted group-open:hidden">Show</span>
        <span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span>
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <label>Date from<input name="dateFrom" type="date" value={filters.dateFrom} onChange={update} className={inputClass} /></label>
        <label>Date to<input name="dateTo" type="date" value={filters.dateTo} onChange={update} className={inputClass} /></label>
        <label>Minimum USD<input name="minAmount" type="number" min="0" step="0.01" value={filters.minAmount} onChange={update} className={inputClass} placeholder="0.00" /></label>
        <label>Maximum USD<input name="maxAmount" type="number" min="0" step="0.01" value={filters.maxAmount} onChange={update} className={inputClass} placeholder="0.00" /></label>
      </div>
    </details>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-text-muted">
      <span>Showing {shownCount.toLocaleString()} of {totalCount.toLocaleString()} records</span>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => onChange({ ...filters, foreignCurrencyOnly: !filters.foreignCurrencyOnly })}
          aria-pressed={filters.foreignCurrencyOnly}
          disabled={foreignCurrencyCount === 0}
          className="rounded-input border border-warning/40 bg-warning/5 px-3 py-2 font-medium text-warning transition hover:bg-warning/10 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-text-muted"
        >
          {filters.foreignCurrencyOnly ? "Show all source records" : `Needs FX review (${foreignCurrencyCount.toLocaleString()})`}
        </button>
        {canManage && <button type="button" onClick={() => void exportCsv()} disabled={exporting} className="rounded-input border border-border bg-surface px-3 py-2 font-medium text-brand-accent transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-text-muted">{exporting ? "Exporting…" : "Export CSV"}</button>}
        <button type="button" onClick={() => onChange(initialB2cLedgerFilters)} disabled={!hasFilters} className="font-medium text-brand-accent disabled:cursor-not-allowed disabled:text-text-muted">Clear filters</button>
      </div>
    </div>
    {exportFeedback?.href === exportHref && <p role={exportFeedback.kind === "error" ? "alert" : "status"} className={`mt-3 text-sm ${exportFeedback.kind === "error" ? "text-danger" : "text-text-secondary"}`}>{exportFeedback.message}</p>}
  </div>;
}
