"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DataTable, EmptyState, ErrorState, MetricCard, SectionCard, StatusBadge, TableCell, TableHead, TableHeader } from "@/components/ui";
import { B2cLedgerFilters, initialB2cLedgerFilters } from "@/features/b2c/b2c-ledger-filters";
import { B2cPaymentReviewActions } from "@/features/b2c/b2c-payment-review-actions";
import { B2cPeriodSelector } from "@/features/b2c/b2c-period-selector";
import type { B2cDashboardSnapshot, B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

type LedgerSort = { key: "date" | "amount"; direction: "ascending" | "descending" };

function formatCoverageTimestamp(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bahrain" }).format(new Date(value));
}

function filterRows(rows: B2cLedgerRow[], filters: typeof initialB2cLedgerFilters): B2cLedgerRow[] {
  const search = filters.search.trim().toLowerCase();
  const minimum = filters.minAmount === "" ? null : Number(filters.minAmount);
  const maximum = filters.maxAmount === "" ? null : Number(filters.maxAmount);
  return rows.filter((row) => {
    const searchable = [row.customerName, row.customerEmail, row.customerPhone, row.providerReference].filter(Boolean).join(" ").toLowerCase();
    const absoluteAmount = Math.abs(Number(row.amountValueUsd));
    return (!search || searchable.includes(search))
      && (!filters.dateFrom || row.dateValue >= filters.dateFrom)
      && (!filters.dateTo || row.dateValue <= filters.dateTo)
      && (minimum === null || absoluteAmount >= minimum)
      && (maximum === null || absoluteAmount <= maximum)
      && (filters.status === "all" || row.paymentStatus === filters.status)
      && (filters.source === "all" || row.source === filters.source)
      && (filters.category === "all" || row.category === filters.category)
      && (filters.issue === "all" || filters.issue === "none" ? (filters.issue !== "none" || row.issue === null) : row.issue === filters.issue);
  });
}

function sortRows(rows: B2cLedgerRow[], sort: LedgerSort): B2cLedgerRow[] {
  const multiplier = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((first, second) => {
    if (sort.key === "date") return first.dateValue.localeCompare(second.dateValue) * multiplier;
    return (Number(first.amountValueUsd) - Number(second.amountValueUsd)) * multiplier;
  });
}

function LedgerSortHeader({ label, sortKey, sort, onSort }: {
  label: string;
  sortKey: LedgerSort["key"];
  sort: LedgerSort;
  onSort: (key: LedgerSort["key"]) => void;
}) {
  const isCurrent = sort.key === sortKey;
  const directionLabel = isCurrent && sort.direction === "ascending" ? "ascending" : "descending";
  return <TableHeader>
    <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 font-inherit text-left hover:text-text-primary" aria-label={`Sort by ${label}, currently ${directionLabel}`}>
      {label}<span aria-hidden="true" className={isCurrent ? "text-brand-accent" : "text-text-muted"}>{isCurrent ? (sort.direction === "ascending" ? "↑" : "↓") : "↕"}</span>
    </button>
  </TableHeader>;
}

/** B2C operations is a source ledger: refunds are separate, and source problems never become financial totals. */
export function B2cOperations({ snapshot = null, loadError }: { snapshot?: B2cDashboardSnapshot | null; loadError?: string }) {
  const [filters, setFilters] = useState(initialB2cLedgerFilters);
  const [sort, setSort] = useState<LedgerSort>({ key: "date", direction: "descending" });
  const visibleRows = useMemo(() => snapshot ? sortRows(filterRows(snapshot.rows, filters), sort) : [], [filters, snapshot, sort]);
  const sources = useMemo(() => snapshot ? [...new Set(snapshot.rows.map((row) => row.source))].sort().map((value) => ({ value, label: value })) : [], [snapshot]);
  const categories = useMemo(() => snapshot ? [...new Set(snapshot.rows.map((row) => row.category))].sort().map((value) => ({ value, label: value })) : [], [snapshot]);
  const issues = useMemo(() => snapshot ? [...new Set(snapshot.rows.flatMap((row) => row.issue ? [row.issue] : []))].sort().map((value) => ({ value, label: value })) : [], [snapshot]);
  function changeSort(key: LedgerSort["key"]) {
    setSort((current) => current.key === key ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" } : { key, direction: "descending" });
  }

  const financialTotalsAvailable = snapshot?.sourceCoverage.reportingTotalsReady ?? false;
  const financialValue = (value: string) => financialTotalsAvailable ? value : "Not fully loaded";
  const sourceAsOf = snapshot ? formatCoverageTimestamp(snapshot.sourceCoverage.dataAsOf) : null;

  return <AppShell title="B2C operations" description="Stripe and other B2C payments are kept separate from B2B. Only completed, mapped, non-duplicate payments contribute to the reported totals; refunds remain separate source records." controls={snapshot ? <B2cPeriodSelector month={snapshot.period.month} /> : undefined}>
    {loadError || !snapshot ? <ErrorState title="B2C data unavailable" description={loadError ?? "The B2C dashboard could not be loaded."} /> : <>
      <div className={`mb-4 rounded-card border p-4 ${financialTotalsAvailable ? "border-success/25 bg-success/5" : "border-warning/30 bg-warning/5"}`} role="status">
        <p className={`font-semibold ${financialTotalsAvailable ? "text-success" : "text-warning"}`}>{snapshot.sourceCoverage.title}</p>
        <p className="mt-1 text-sm leading-6 text-text-secondary">{snapshot.sourceCoverage.description}{sourceAsOf ? ` Source data is current through ${sourceAsOf} Bahrain time.` : ""}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-5">
        <MetricCard label={`Reportable B2C payments · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? financialValue(snapshot.eligiblePaymentsUsd) : "Not loaded"} note={financialTotalsAvailable ? `${snapshot.calculation.reportablePaymentCount} approved payment${snapshot.calculation.reportablePaymentCount === 1 ? "" : "s"}` : "Withheld until the Stripe history is complete"} />
        <MetricCard label={`Linked succeeded refunds · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? financialValue(snapshot.refundsUsd) : "Not loaded"} note={financialTotalsAvailable ? `${snapshot.calculation.eligibleRefundCount} linked refund${snapshot.calculation.eligibleRefundCount === 1 ? "" : "s"} reduce reportable cash` : "Withheld until the Stripe history is complete"} />
        <MetricCard label={`Net B2C cash received · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? financialValue(snapshot.netPaymentsUsd) : "Not loaded"} note={financialTotalsAvailable ? "Reportable payments less linked succeeded refunds; not recognised revenue" : "Withheld until the Stripe history is complete"} />
        <MetricCard label={`Retrieved completed source payments · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.completedSourcePaymentsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Operational source volume only; never a financial total" : "No B2C source records have been received yet"} tone="neutral" />
        <MetricCard label="Open review flags" value={snapshot.hasSourceRecords ? String(snapshot.reviewItems) : "Not loaded"} note={snapshot.hasSourceRecords ? "Flag count; one source record can have more than one" : "No B2C source records have been received yet"} tone={snapshot.reviewItems > 0 ? "warning" : "neutral"} />
      </div>
      <SectionCard title="B2C reporting reconciliation" description="This bridge explains exactly why source activity and reportable cash differ. A completed source payment is counted only after it has a verified email, approved PLAYBOOK category, and no open duplicate or follow-up flag." className="mt-4">
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="text-sm text-text-muted">Completed source payments</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{snapshot.completedSourcePaymentsUsd}</dd><p className="mt-1 text-sm text-text-muted">{snapshot.calculation.completedSourcePaymentCount} payments before review</p></div>
          <div><dt className="text-sm text-text-muted">Excluded pending review</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-warning">{snapshot.calculation.excludedCompletedPaymentsUsd}</dd><p className="mt-1 text-sm text-text-muted">{snapshot.calculation.excludedCompletedPaymentCount} completed payments</p></div>
          <div><dt className="text-sm text-text-muted">Reportable B2C payments</dt><dd className={`mt-1 text-lg font-semibold tabular-nums ${financialTotalsAvailable ? "text-success" : "text-text-muted"}`}>{financialValue(snapshot.eligiblePaymentsUsd)}</dd><p className="mt-1 text-sm text-text-muted">{financialTotalsAvailable ? `${snapshot.calculation.reportablePaymentCount} approved payments` : "Not published while source coverage is incomplete"}</p></div>
          <div><dt className="text-sm text-text-muted">Succeeded source refunds</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{snapshot.sourceRefundsUsd}</dd><p className="mt-1 text-sm text-text-muted">{snapshot.calculation.sourceRefundCount} source refunds; {financialTotalsAvailable ? `${snapshot.refundsUsd} deducted from reportable cash` : "financial deduction withheld"}</p></div>
        </dl>
        <p className="mt-5 border-t border-line pt-4 text-sm leading-6 text-text-secondary">Current exclusions: {snapshot.calculation.unmappedProductCount} unmapped product{snapshot.calculation.unmappedProductCount === 1 ? "" : "s"}, {snapshot.calculation.missingCustomerEmailCount} missing customer email{snapshot.calculation.missingCustomerEmailCount === 1 ? "" : "s"}, {snapshot.calculation.possibleDuplicateCount} possible duplicate{snapshot.calculation.possibleDuplicateCount === 1 ? "" : "s"}, {snapshot.calculation.otherReviewCount} other review item{snapshot.calculation.otherReviewCount === 1 ? "" : "s"}, and {snapshot.calculation.nonSucceededPaymentCount} failed or pending payment{snapshot.calculation.nonSucceededPaymentCount === 1 ? "" : "s"}. Categories can overlap, so these reason counts do not add up to the excluded-payment count.</p>
      </SectionCard>
      <SectionCard title={`B2C source ledger · ${snapshot.period.monthLabel}`} description="Provider IDs are retained for traceability. Use the filters to inspect source records; filtering does not alter reporting totals or Stripe data." className="mt-4">
        {!snapshot.hasSourceRecords ? <EmptyState title="No B2C source records yet" description="Configure the Stripe webhook, send a test payment, or run the 48-hour reconciliation. PLAYBOOK will not display missing source data as zero." /> : <>
          <B2cLedgerFilters filters={filters} onChange={setFilters} sources={sources} categories={categories} issues={issues} shownCount={visibleRows.length} totalCount={snapshot.rows.length} />
          {visibleRows.length === 0 ? <EmptyState title={snapshot.period.isAllTime ? "No B2C records match these filters" : "No B2C records in this month match these filters"} description="Change or clear a filter to see the remaining source records." /> : <DataTable caption="B2C source ledger"><TableHead><TableHeader>Name</TableHeader><TableHeader>Email</TableHeader><TableHeader>Mobile</TableHeader><TableHeader>Record</TableHeader><LedgerSortHeader label="Date" sortKey="date" sort={sort} onSort={changeSort} /><LedgerSortHeader label="Amount" sortKey="amount" sort={sort} onSort={changeSort} /><TableHeader>PLAYBOOK category</TableHeader><TableHeader>Plan / tier</TableHeader><TableHeader>Source</TableHeader><TableHeader>Payment</TableHeader><TableHeader>Issue</TableHeader><TableHeader>Provider ID</TableHeader><TableHeader><span className="sr-only">Admin action</span></TableHeader></TableHead><tbody className="divide-y divide-line">{visibleRows.map((row) => <tr key={`${row.recordType}-${row.id}`}><TableCell className="font-medium">{row.customerName ?? "—"}</TableCell><TableCell>{row.customerEmail ?? "—"}</TableCell><TableCell>{row.customerPhone ?? "—"}</TableCell><TableCell>{row.recordType}</TableCell><TableCell>{row.date}{row.hasLocalCorrection && <span className="mt-1 block text-xs font-medium text-brand-accent">Locally corrected</span>}</TableCell><TableCell className="font-medium tabular-nums">{row.amountUsd}</TableCell><TableCell>{row.category}</TableCell><TableCell><span>{row.membershipTier ?? "—"}</span>{row.billingInterval && <span className="mt-0.5 block text-xs text-text-muted">{row.billingInterval}</span>}</TableCell><TableCell>{row.source}</TableCell><TableCell><StatusBadge status={row.paymentStatus} /></TableCell><TableCell>{row.issue ? <StatusBadge status={row.issue} /> : "—"}</TableCell><TableCell className="font-mono text-xs">{row.providerReference ?? "—"}</TableCell><TableCell><B2cPaymentReviewActions row={row} /></TableCell></tr>)}</tbody></DataTable>}
        </>}
      </SectionCard>
    </>}
  </AppShell>;
}
