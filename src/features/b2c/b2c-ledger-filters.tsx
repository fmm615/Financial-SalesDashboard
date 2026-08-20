"use client";

import type { ChangeEvent } from "react";

export type B2cLedgerFiltersState = {
  search: string;
  dateFrom: string;
  dateTo: string;
  minAmount: string;
  maxAmount: string;
  status: string;
  source: string;
  category: string;
  issue: string;
  foreignCurrencyOnly: boolean;
  tapStatementUnmatchedOnly: boolean;
};

export const initialB2cLedgerFilters: B2cLedgerFiltersState = {
  search: "", dateFrom: "", dateTo: "", minAmount: "", maxAmount: "", status: "all", source: "all", category: "all", issue: "all", foreignCurrencyOnly: false, tapStatementUnmatchedOnly: false,
};

type Option = { value: string; label: string };

/** Display-only controls for narrowing the already-loaded B2C source ledger. */
export function B2cLedgerFilters({ filters, onChange, onTapStatementUnmatchedToggle, sources, categories, issues, shownCount, totalCount, foreignCurrencyCount, tapStatementUnmatchedCount }: {
  filters: B2cLedgerFiltersState;
  onChange: (filters: B2cLedgerFiltersState) => void;
  onTapStatementUnmatchedToggle?: () => void;
  sources: Option[];
  categories: Option[];
  issues: Option[];
  shownCount: number;
  totalCount: number;
  foreignCurrencyCount: number;
  tapStatementUnmatchedCount: number;
}) {
  function update(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    onChange({ ...filters, [event.target.name]: event.target.value });
  }
  const inputClass = "mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
  const hasFilters = Object.entries(filters).some(([key, value]) => {
    if (key === "foreignCurrencyOnly" || key === "tapStatementUnmatchedOnly") return value === true;
    return key === "status" || key === "source" || key === "category" || key === "issue" ? value !== "all" : value !== "";
  });
  // Advanced filters live under "More filters"; the badge counts only those, so
  // an Admin can tell at a glance whether a hidden filter is narrowing the ledger.
  const advancedFilterCount = [
    filters.dateFrom !== "",
    filters.dateTo !== "",
    filters.minAmount !== "",
    filters.maxAmount !== "",
    filters.category !== "all",
    filters.foreignCurrencyOnly,
    filters.tapStatementUnmatchedOnly,
  ].filter(Boolean).length;
  return <div className="mb-5 rounded-input border border-border bg-surface-muted/30 p-4">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="sm:col-span-2 lg:col-span-1">Search<input name="search" value={filters.search} onChange={update} className={inputClass} placeholder="Name, email, mobile, or ID" /></label>
      <label>Source<select name="source" value={filters.source} onChange={update} className={inputClass}><option value="all">All sources</option>{sources.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label>
      <label>Payment status<select name="status" value={filters.status} onChange={update} className={inputClass}><option value="all">All statuses</option><option value="Completed">Completed</option><option value="Failed">Failed</option><option value="Pending">Pending</option><option value="Refunded">Refunded</option></select></label>
      <label>Issue<select name="issue" value={filters.issue} onChange={update} className={inputClass}><option value="all">All issues</option><option value="none">No issue</option>{issues.map((issue) => <option key={issue.value} value={issue.value}>{issue.label}</option>)}</select></label>
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
        <label>PLAYBOOK category<select name="category" value={filters.category} onChange={update} className={inputClass}><option value="all">All categories</option>{categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label>
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
        <button
          type="button"
          onClick={() => {
            if (onTapStatementUnmatchedToggle) {
              onTapStatementUnmatchedToggle();
              return;
            }
            onChange({ ...filters, tapStatementUnmatchedOnly: !filters.tapStatementUnmatchedOnly });
          }}
          aria-pressed={filters.tapStatementUnmatchedOnly}
          disabled={tapStatementUnmatchedCount === 0}
          className={`rounded-input border px-3 py-2 font-medium transition ${filters.tapStatementUnmatchedOnly ? "border-warning/50 bg-warning/10 text-warning" : "border-warning/40 bg-warning/5 text-warning hover:bg-warning/10"} disabled:cursor-not-allowed disabled:border-border disabled:bg-surface disabled:text-text-muted`}
        >
          Tap statement unmatched ({tapStatementUnmatchedCount.toLocaleString()})
        </button>
        <button type="button" onClick={() => onChange(initialB2cLedgerFilters)} disabled={!hasFilters} className="font-medium text-brand-accent disabled:cursor-not-allowed disabled:text-text-muted">Clear filters</button>
      </div>
    </div>
  </div>;
}
