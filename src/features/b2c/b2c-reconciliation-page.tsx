"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorState, LoadingSkeleton, MetricCard, SectionCard, StatusBadge } from "@/components/ui";
import type { B2cReconciliationSafeSummary } from "@/server/repositories/b2c-finance-reconciliation-repository";

function displayCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function displaySourceStatus(status: B2cReconciliationSafeSummary["sources"][number]["status"]): string {
  return status === "not_loaded" ? "Not loaded" : status[0].toUpperCase() + status.slice(1);
}

/** Coverage-only Operations page. It never exposes source rows or claims a B2C revenue total. */
export function B2cReconciliationPage() {
  const [summary, setSummary] = useState<B2cReconciliationSafeSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadSummary = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch("/api/b2c/reconciliation", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("summary" in payload)) throw new Error("Summary unavailable");
      setSummary(payload.summary as B2cReconciliationSafeSummary);
    } catch {
      setSummary(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  return <AppShell title="B2C reconciliation" description="A controlled intake view for Finance workbook and provider evidence. Until reconciliation and Finance approval are complete, B2C Finance revenue is intentionally not published.">
    {!summary && !loadError && <section className="rounded-card border border-border bg-surface p-5 shadow-card"><p className="mb-3 text-sm text-text-muted">Loading B2C reconciliation coverage</p><LoadingSkeleton rows={5} /></section>}
    {loadError && <ErrorState title="Unable to load B2C reconciliation coverage" description="No import state or financial value has been changed. Please try again after confirming the required migrations are applied." />}
    {summary && <>
      <section className="rounded-card border border-warning/30 bg-warning/5 p-5" role="status">
        <StatusBadge status="Not fully loaded" />
        <h2 className="mt-3 text-lg font-semibold tracking-[-0.02em] text-text-primary">B2C Finance revenue is not published</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-secondary">{summary.publicationMessage}</p>
      </section>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Staged Finance rows" value={displayCount(summary.counts.stagedRows)} note="Retained for reconciliation; not a revenue total" />
        <MetricCard label="Needs Finance review" value={displayCount(summary.counts.needsReviewRows)} note="Missing, conflicting, or ambiguous source values" tone={summary.counts.needsReviewRows > 0 ? "warning" : "neutral"} />
        <MetricCard label="Zero-value rows" value={displayCount(summary.counts.zeroValueRows)} note="Kept as source history; excluded from revenue candidates" tone="warning" />
        <MetricCard label="Unresolved groups" value={displayCount(summary.counts.unresolvedGroups)} note="Groups awaiting an explicit Finance decision" tone={summary.counts.unresolvedGroups > 0 ? "warning" : "neutral"} />
      </div>
      <SectionCard title="Required source coverage" description="Every source must be complete and Finance-approved before a B2C Finance revenue period can be published." className="mt-4">
        <ul className="divide-y divide-border" aria-label="B2C source coverage">
          {summary.sources.map((source) => <li key={source.key} className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-text-primary">{source.label}</p><p className="mt-1 text-sm text-text-muted">{source.key === "payment_tracker" ? "Finance revenue candidates, excluding customer VAT" : source.key === "tap_statement" ? "Payment and settlement evidence only; retained in original currency" : "Required payment evidence and fee context; not yet supplied"}</p></div><StatusBadge status={displaySourceStatus(source.status)} /></li>)}
        </ul>
      </SectionCard>
      <SectionCard title="How this operates" description="The dashboard keeps evidence and revenue separate so no source is counted twice.">
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-text-secondary"><li>Finance rows are staged with their original tab, row number, and file hash.</li><li>Duplicate candidates and date conflicts remain unresolved until Finance records a reasoned decision.</li><li>Tap and Stripe records support reconciliation but never create another Finance revenue row.</li><li>Only a later Finance approval step can publish a verified B2C period.</li></ol>
      </SectionCard>
    </>}
  </AppShell>;
}
