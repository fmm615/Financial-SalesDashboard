"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, MetricCard, SectionCard } from "@/components/ui";
import { useAppRole } from "@/lib/auth/role-context";
import { B2cLedgerFilters, initialB2cLedgerFilters, type B2cLedgerFiltersState } from "@/features/b2c/b2c-ledger-filters";
import { B2cLedgerTable, type B2cSafeLedgerRow } from "@/features/b2c/b2c-ledger-table";
import { B2cPeriodSelector } from "@/features/b2c/b2c-period-selector";
import { B2cWorkQueue, type B2cWorkQueueFilter } from "@/features/b2c/b2c-work-queue";
import { B2cSourceManagement } from "@/features/b2c/b2c-source-management";
import { B2cPaymentReviewDrawer, type B2cPaymentReviewDrawerTarget } from "@/features/b2c/b2c-payment-review-drawer";
import type { B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";
import type { B2cWorkspaceOverview } from "@/server/repositories/b2c-workspace-repository";
import type { B2cWorkItem } from "@/server/services/b2c-work-items";

type WorkspaceTab = "work" | "ledger" | "sources";
const TABS: Array<{ value: WorkspaceTab; label: string; adminOnly?: boolean }> = [
  { value: "work", label: "Work queue", adminOnly: true },
  { value: "ledger", label: "Ledger" },
  { value: "sources", label: "Sources" },
];

type WorkspaceLedgerResponse = {
  role: "admin" | "viewer";
  ledger: { rows: B2cSafeLedgerRow[]; nextCursor: string | null; hasMore: boolean; totalCount: number };
  workItems: B2cWorkspaceOverview | null;
};

function formatCoverageTimestamp(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bahrain" }).format(new Date(value));
}

function filterRows(rows: B2cSafeLedgerRow[], filters: B2cLedgerFiltersState): B2cSafeLedgerRow[] {
  const search = filters.search.trim().toLowerCase();
  const minimum = filters.minAmount === "" ? null : Number(filters.minAmount);
  const maximum = filters.maxAmount === "" ? null : Number(filters.maxAmount);

  return rows.filter((row) => {
    const searchable = [row.customerName, row.customerEmail, row.customerPhone, row.providerReference].filter(Boolean).join(" ").toLowerCase();
    const absoluteAmount = row.amountValueUsd === null ? null : Math.abs(Number(row.amountValueUsd));

    return (
      (!search || searchable.includes(search)) &&
      (!filters.dateFrom || row.dateValue >= filters.dateFrom) &&
      (!filters.dateTo || row.dateValue <= filters.dateTo) &&
      (minimum === null || (absoluteAmount !== null && absoluteAmount >= minimum)) &&
      (maximum === null || (absoluteAmount !== null && absoluteAmount <= maximum)) &&
      (filters.status === "all" || row.paymentStatus === filters.status) &&
      (filters.source === "all" || row.source === filters.source) &&
      (filters.category === "all" || row.category === filters.category) &&
      (!filters.foreignCurrencyOnly || row.foreignCurrencyReview) &&
      (!filters.tapStatementUnmatchedOnly || row.tapStatementUnmatched === true) &&
      (filters.issue === "all" || filters.issue === "none" ? filters.issue !== "none" || row.issue === null : row.issue === filters.issue)
    );
  });
}

function TabBar({ active, onSelect, showWork }: { active: WorkspaceTab; onSelect: (tab: WorkspaceTab) => void; showWork: boolean }) {
  const visible = TABS.filter((tab) => !tab.adminOnly || showWork);
  function handleKeyDown(event: KeyboardEvent, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % visible.length : (index - 1 + visible.length) % visible.length;
    onSelect(visible[nextIndex].value);
  }
  return <div role="tablist" aria-label="B2C workspace" className="flex flex-wrap gap-2 border-b border-border pb-3">
    {visible.map((tab, index) => <button
      key={tab.value} role="tab" type="button" id={`b2c-tab-${tab.value}`} aria-selected={active === tab.value} aria-controls={`b2c-panel-${tab.value}`}
      tabIndex={active === tab.value ? 0 : -1}
      onClick={() => onSelect(tab.value)} onKeyDown={(event) => handleKeyDown(event, index)}
      className={`min-h-11 rounded-pill px-4 text-sm font-semibold transition-colors ${active === tab.value ? "bg-brand-primary text-white" : "bg-surface-muted text-text-secondary hover:text-text-primary"}`}
    >
      {tab.label}
    </button>)}
  </div>;
}

/**
 * The one B2C workspace: `Work queue`, `Ledger`, and `Sources` tabs stored in
 * the URL. Replaces the three former front doors (`/operations/b2c`,
 * `/operations/b2c/reconciliation`, `/admin/b2c-finance`). See "Final B2C UI
 * Inventory" in docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md.
 */
export function B2cWorkspace({
  snapshot = null,
  loadError,
  initialTapStatementUnmatchedOnly = false,
}: {
  snapshot?: B2cDashboardSnapshot | null;
  loadError?: string;
  initialTapStatementUnmatchedOnly?: boolean;
}) {
  const role = useAppRole();
  const canManage = role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const requestedTab = searchParams.get("tab") as WorkspaceTab | null;
  const activeTab: WorkspaceTab = requestedTab === "work" && !canManage ? "ledger" : (requestedTab ?? (canManage ? "work" : "ledger"));
  const activeQueue = (searchParams.get("queue") as B2cWorkQueueFilter | null) ?? "all";
  const recordParam = searchParams.get("record");

  function setQuery(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key); else params.set(key, value);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  const [ledgerRows, setLedgerRows] = useState<B2cSafeLedgerRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [workItems, setWorkItems] = useState<B2cWorkspaceOverview | null>(null);
  const [ledgerLoadError, setLedgerLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [filters, setFilters] = useState<B2cLedgerFiltersState>(() => ({ ...initialB2cLedgerFilters, tapStatementUnmatchedOnly: initialTapStatementUnmatchedOnly }));
  const [drawerTarget, setDrawerTarget] = useState<B2cPaymentReviewDrawerTarget | null>(null);

  const period = snapshot?.period.month;

  const loadLedgerPage = useCallback(async (cursor: string | null) => {
    const params = new URLSearchParams({ limit: "100" });
    if (period) params.set("period", period);
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/b2c/workspace?${params.toString()}`, { cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object" || !("ledger" in payload)) throw new Error("Workspace data unavailable");
    return payload as WorkspaceLedgerResponse;
  }, [period]);

  const reload = useCallback(async () => {
    setLedgerLoadError(false);
    try {
      const page = await loadLedgerPage(null);
      setLedgerRows(page.ledger.rows);
      setNextCursor(page.ledger.nextCursor);
      setHasMore(page.ledger.hasMore);
      setWorkItems(page.workItems);
    } catch {
      setLedgerLoadError(true);
    }
  }, [loadLedgerPage]);

  useEffect(() => { void reload(); }, [reload]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await loadLedgerPage(nextCursor);
      setLedgerRows((current) => [...current, ...page.ledger.rows]);
      setNextCursor(page.ledger.nextCursor);
      setHasMore(page.ledger.hasMore);
    } catch {
      setLedgerLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const visibleRows = useMemo(() => filterRows(ledgerRows, filters), [ledgerRows, filters]);
  const sources = useMemo(() => [...new Set(ledgerRows.map((row) => row.source))].sort().map((value) => ({ value, label: value })), [ledgerRows]);
  const categories = useMemo(() => [...new Set(ledgerRows.map((row) => row.category))].sort().map((value) => ({ value, label: value })), [ledgerRows]);
  const issues = useMemo(() => [...new Set(ledgerRows.flatMap((row) => (row.issue ? [row.issue] : [])))].sort().map((value) => ({ value, label: value })), [ledgerRows]);
  const foreignCurrencyCount = useMemo(() => ledgerRows.filter((row) => row.foreignCurrencyReview).length, [ledgerRows]);
  // Undated Tap statement evidence falls outside every month-scoped period, so
  // the retained global count comes from the snapshot rather than the current page.
  const tapStatementUnmatchedCount = snapshot?.tapStatementUnmatchedCount ?? ledgerRows.filter((row) => row.tapStatementUnmatched).length;

  function toggleTapStatementUnmatchedOnly() {
    if (snapshot && !snapshot.period.isAllTime) {
      setFilters({ ...initialB2cLedgerFilters, tapStatementUnmatchedOnly: true });
      setQuery({ period: "all", tab: "ledger" });
      return;
    }
    setFilters((current) => ({ ...current, tapStatementUnmatchedOnly: !current.tapStatementUnmatchedOnly }));
  }

  // A record deep-linked from the Work queue or Review Queue opens the same shared drawer.
  useEffect(() => {
    if (!recordParam) { setDrawerTarget(null); return; }
    const row = ledgerRows.find((candidate) => candidate.id === recordParam);
    if (row) { setDrawerTarget({ kind: "row", row }); return; }
    const item = workItems?.items.find((candidate) => candidate.recordId === recordParam);
    if (item) setDrawerTarget({ kind: "workItem", item });
  }, [recordParam, ledgerRows, workItems]);

  function closeDrawer() {
    setDrawerTarget(null);
    setQuery({ record: null });
  }

  function openRow(row: B2cSafeLedgerRow) {
    setDrawerTarget({ kind: "row", row });
    setQuery({ record: row.id });
  }

  function openWorkItem(item: B2cWorkItem) {
    // Setting `record` re-triggers the lookup effect above, which opens the
    // drawer with either the full loaded row (Ledger-quality detail) or, when
    // the record isn't on the current ledger page, the work item itself.
    router.push(item.href);
  }

  const financialTotalsAvailable = snapshot?.sourceCoverage.reportingTotalsReady ?? false;
  const financialValue = (value: string) => (financialTotalsAvailable ? value : "Not fully loaded");
  const sourceAsOf = snapshot ? formatCoverageTimestamp(snapshot.sourceCoverage.dataAsOf) : null;

  if (loadError || !snapshot) {
    return <AppShell title="B2C" description="Stripe, Tap, and Finance-approved B2C payments in one workspace.">
      <ErrorState title="B2C data unavailable" description={loadError ?? "The B2C workspace could not be loaded."} />
    </AppShell>;
  }

  return <AppShell
    title="B2C"
    description="One workspace for B2C work items, the full ledger, and provider/Finance sources. Only completed, verified, non-duplicate payments contribute to totals."
    controls={<B2cPeriodSelector month={snapshot.period.month} />}
  >
    <div className={`mb-4 rounded-card border p-4 ${financialTotalsAvailable ? "border-success/25 bg-success/5" : "border-warning/30 bg-warning/5"}`} role="status">
      <p className={`font-semibold ${financialTotalsAvailable ? "text-success" : "text-warning"}`}>{snapshot.sourceCoverage.title}</p>
      <p className="mt-1 text-sm leading-6 text-text-secondary">{snapshot.sourceCoverage.description}{sourceAsOf ? ` Source data is current through ${sourceAsOf} Bahrain time.` : ""}</p>
    </div>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label={`Reportable cash · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? financialValue(snapshot.eligiblePaymentsUsd) : "Not loaded"} note={financialTotalsAvailable ? `${snapshot.calculation.reportablePaymentCount} approved payment${snapshot.calculation.reportablePaymentCount === 1 ? "" : "s"}` : "Withheld until source coverage is complete"} />
      <MetricCard label={`Linked refunds · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? financialValue(snapshot.refundsUsd) : "Not loaded"} note={financialTotalsAvailable ? `${snapshot.calculation.eligibleRefundCount} linked refund${snapshot.calculation.eligibleRefundCount === 1 ? "" : "s"}` : "Withheld until source coverage is complete"} />
      <MetricCard label={`Net cash · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? financialValue(snapshot.netPaymentsUsd) : "Not loaded"} note="Reportable payments less linked refunds; not recognised revenue" />
      <MetricCard label="Blockers" value={snapshot.hasSourceRecords ? String(snapshot.reviewItems) : "Not loaded"} note="Open review flags across the B2C ledger" tone={snapshot.reviewItems > 0 ? "warning" : "neutral"} />
    </div>

    <div className="mt-5">
      <TabBar active={activeTab} onSelect={(tab) => setQuery({ tab })} showWork={canManage} />
    </div>

    {ledgerLoadError && <div className="mt-4"><ErrorState title="Unable to load the B2C workspace" description="No data has been changed. Please try again." /></div>}

    <div role="tabpanel" id={`b2c-panel-${activeTab}`} aria-labelledby={`b2c-tab-${activeTab}`} className="mt-4">
      {activeTab === "work" && canManage && (workItems
        ? <B2cWorkQueue overview={workItems} activeQueue={activeQueue} onSelectQueue={(queue) => setQuery({ queue: queue === "all" ? null : queue })} onOpenItem={openWorkItem} onPosted={reload} />
        : <EmptyState title="Loading the Work queue" description="Preparing prioritized B2C records." />)}

      {activeTab === "ledger" && <SectionCard title={`B2C ledger · ${snapshot.period.monthLabel}`} description="Customer, date, amount, source, and status. Open a record to see full detail, evidence, and its next safe action.">
        <B2cLedgerFilters filters={filters} onChange={setFilters} onTapStatementUnmatchedToggle={toggleTapStatementUnmatchedOnly} sources={sources} categories={categories} issues={issues} shownCount={visibleRows.length} totalCount={ledgerRows.length} foreignCurrencyCount={foreignCurrencyCount} tapStatementUnmatchedCount={tapStatementUnmatchedCount} />
        {visibleRows.length === 0 ? <EmptyState title="No B2C records match these filters" description="Change or clear a filter to see the remaining records." /> : <B2cLedgerTable rows={visibleRows} onReview={openRow} />}
        {hasMore && <div className="mt-4 text-center"><button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="min-h-11 rounded-pill border border-border px-5 text-sm font-medium text-brand-accent hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60">{loadingMore ? "Loading…" : "Load more"}</button></div>}

        <details className="mt-6 rounded-card border border-border">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-text-primary">Why totals differ</summary>
          <div className="border-t border-border px-4 py-4">
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div><dt className="text-sm text-text-muted">Completed source payments</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{snapshot.completedSourcePaymentsUsd}</dd><p className="mt-1 text-sm text-text-muted">{snapshot.calculation.completedSourcePaymentCount} payments before review</p></div>
              <div><dt className="text-sm text-text-muted">Excluded pending review</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-warning">{snapshot.calculation.excludedCompletedPaymentsUsd}</dd><p className="mt-1 text-sm text-text-muted">{snapshot.calculation.excludedCompletedPaymentCount} completed payments</p></div>
              <div><dt className="text-sm text-text-muted">Reportable B2C payments</dt><dd className={`mt-1 text-lg font-semibold tabular-nums ${financialTotalsAvailable ? "text-success" : "text-text-muted"}`}>{financialValue(snapshot.eligiblePaymentsUsd)}</dd><p className="mt-1 text-sm text-text-muted">{financialTotalsAvailable ? `${snapshot.calculation.reportablePaymentCount} approved payments` : "Not published while source coverage is incomplete"}</p></div>
              <div><dt className="text-sm text-text-muted">Succeeded source refunds</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{snapshot.sourceRefundsUsd}</dd><p className="mt-1 text-sm text-text-muted">{snapshot.calculation.sourceRefundCount} source refunds; {financialTotalsAvailable ? `${snapshot.refundsUsd} deducted` : "deduction withheld"}</p></div>
            </dl>
            <p className="mt-5 border-t border-border pt-4 text-sm leading-6 text-text-secondary">Current exclusions: {foreignCurrencyCount} foreign-currency record{foreignCurrencyCount === 1 ? "" : "s"} awaiting approved FX, {snapshot.calculation.unmappedProductCount} unmapped product{snapshot.calculation.unmappedProductCount === 1 ? "" : "s"}, {snapshot.calculation.missingCustomerEmailCount} missing customer email{snapshot.calculation.missingCustomerEmailCount === 1 ? "" : "s"}, {snapshot.calculation.possibleDuplicateCount} possible duplicate{snapshot.calculation.possibleDuplicateCount === 1 ? "" : "s"}, {snapshot.calculation.otherReviewCount} other review item{snapshot.calculation.otherReviewCount === 1 ? "" : "s"}, and {snapshot.calculation.nonSucceededPaymentCount} failed or pending payment{snapshot.calculation.nonSucceededPaymentCount === 1 ? "" : "s"}. {snapshot.calculation.financeExceptionPaymentCount} payment{snapshot.calculation.financeExceptionPaymentCount === 1 ? " is" : "s are"} included by a Finance exception.</p>
          </div>
        </details>
      </SectionCard>}

      {activeTab === "sources" && <B2cSourceManagement />}
    </div>

    <B2cPaymentReviewDrawer target={drawerTarget} onClose={closeDrawer} />
  </AppShell>;
}
