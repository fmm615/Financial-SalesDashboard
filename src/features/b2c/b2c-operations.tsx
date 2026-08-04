"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DataTable, EmptyState, ErrorState, MetricCard, SectionCard, StatusBadge, TableCell, TableHead, TableHeader } from "@/components/ui";
import { B2cLedgerFilters, initialB2cLedgerFilters } from "@/features/b2c/b2c-ledger-filters";
import { B2cPeriodSelector } from "@/features/b2c/b2c-period-selector";
import type { B2cDashboardSnapshot, B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

type LedgerSort = { key: "date" | "amount"; direction: "ascending" | "descending" };

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

  return <AppShell title="B2C operations" description="Stripe and other B2C payments are kept separate from B2B. Only completed, mapped, non-duplicate payments contribute to the reported totals; refunds remain separate source records." controls={snapshot ? <B2cPeriodSelector month={snapshot.period.month} /> : undefined}>
    {loadError || !snapshot ? <ErrorState title="B2C data unavailable" description={loadError ?? "The B2C dashboard could not be loaded."} /> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={`Eligible B2C payments · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.eligiblePaymentsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Succeeded, mapped payments only" : "No B2C source records have been received yet"} />
        <MetricCard label={`Refunds · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.refundsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Recorded separately from original payments" : "No B2C source records have been received yet"} />
        <MetricCard label={`Net B2C payments · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.netPaymentsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Eligible payments less eligible refunds; not recognised revenue" : "No B2C source records have been received yet"} />
        <MetricCard label="Items needing review" value={snapshot.hasSourceRecords ? String(snapshot.reviewItems) : "Not loaded"} note={snapshot.hasSourceRecords ? "Duplicates, unmapped products, failures, and refunds" : "No B2C source records have been received yet"} tone={snapshot.reviewItems > 0 ? "warning" : "neutral"} />
      </div>
      <SectionCard title={`B2C source ledger · ${snapshot.period.monthLabel}`} description="Provider IDs are retained for traceability. Use the filters to inspect source records; filtering does not alter reporting totals or Stripe data." className="mt-4">
        {!snapshot.hasSourceRecords ? <EmptyState title="No B2C source records yet" description="Configure the Stripe webhook, send a test payment, or run the 48-hour reconciliation. PLAYBOOK will not display missing source data as zero." /> : <>
          <B2cLedgerFilters filters={filters} onChange={setFilters} sources={sources} categories={categories} issues={issues} shownCount={visibleRows.length} totalCount={snapshot.rows.length} />
          {visibleRows.length === 0 ? <EmptyState title={snapshot.period.isAllTime ? "No B2C records match these filters" : "No B2C records in this month match these filters"} description="Change or clear a filter to see the remaining source records." /> : <DataTable caption="B2C source ledger"><TableHead><TableHeader>Name</TableHeader><TableHeader>Email</TableHeader><TableHeader>Mobile</TableHeader><TableHeader>Record</TableHeader><LedgerSortHeader label="Date" sortKey="date" sort={sort} onSort={changeSort} /><LedgerSortHeader label="Amount" sortKey="amount" sort={sort} onSort={changeSort} /><TableHeader>Category</TableHeader><TableHeader>Tier</TableHeader><TableHeader>Source</TableHeader><TableHeader>Payment</TableHeader><TableHeader>Issue</TableHeader><TableHeader>Provider ID</TableHeader></TableHead><tbody className="divide-y divide-line">{visibleRows.map((row) => <tr key={`${row.recordType}-${row.id}`}><TableCell className="font-medium">{row.customerName ?? "—"}</TableCell><TableCell>{row.customerEmail ?? "—"}</TableCell><TableCell>{row.customerPhone ?? "—"}</TableCell><TableCell>{row.recordType}</TableCell><TableCell>{row.date}</TableCell><TableCell className="font-medium tabular-nums">{row.amountUsd}</TableCell><TableCell>{row.category}</TableCell><TableCell>{row.membershipTier ?? "—"}</TableCell><TableCell>{row.source}</TableCell><TableCell><StatusBadge status={row.paymentStatus} /></TableCell><TableCell>{row.issue ? <StatusBadge status={row.issue} /> : "—"}</TableCell><TableCell className="font-mono text-xs">{row.providerReference ?? "—"}</TableCell></tr>)}</tbody></DataTable>}
        </>}
      </SectionCard>
    </>}
  </AppShell>;
}
