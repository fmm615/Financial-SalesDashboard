"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DataTable, EmptyState, ErrorState, MetricCard, SectionCard, StatusBadge, TableCell, TableHead, TableHeader } from "@/components/ui";
import { ManualDealEntry } from "@/features/b2b/manual-deal-entry";
import { B2bDealAdminActions } from "@/features/b2b/b2b-deal-admin-actions";
import { B2bPeriodSelector } from "@/features/b2b/b2b-period-selector";
import type { B2bDashboardSnapshot } from "@/server/repositories/b2b-dashboard-repository";

function formatUsd(value: string | number): string {
  const [whole, fraction = ""] = String(value).split(".");
  return `$${Number(whole).toLocaleString("en-US")}${fraction ? `.${fraction.slice(0, 2).padEnd(2, "0")}` : ""}`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
}

function stageLabel(stage: string): string {
  return stage.split("_").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

const stageOrder = ["discovery", "qualified", "proposal", "negotiation", "parked", "closed_won", "closed_lost"];

function compareStages(first: string, second: string): number {
  const firstIndex = stageOrder.indexOf(first);
  const secondIndex = stageOrder.indexOf(second);
  return (firstIndex === -1 ? stageOrder.length : firstIndex) - (secondIndex === -1 ? stageOrder.length : secondIndex) || first.localeCompare(second);
}

function RecognisedSalesCell({ status, totalUsd }: { status: B2bDashboardSnapshot["deals"][number]["recognisedStatus"]; totalUsd: string | null }) {
  return <div className="flex min-w-32 flex-col items-start gap-1"><StatusBadge status={status} />{totalUsd && <span className="text-xs font-medium text-text-secondary">Total: {totalUsd}</span>}</div>;
}

function PipelineByStage({ stages }: { stages: B2bDashboardSnapshot["pipelineByStage"] }) {
  return <SectionCard title="Open pipeline by stage" description="Current eligible open-deal value only. Deals awaiting Admin review and closed deals are excluded." className="mt-4">
    {stages.length === 0 ? <EmptyState title="No eligible open pipeline" description="There are no active, reportable open deals to group by stage." /> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{stages.map((stage) => <div key={stage.stage} className="rounded-input border border-border bg-surface-muted/40 p-4"><p className="text-sm font-medium text-text-secondary">{stageLabel(stage.stage)}</p><p className="mt-2 text-xl font-semibold tabular-nums text-text-primary">{stage.amountUsd}</p><p className="mt-1 text-xs text-text-muted">{stage.dealCount} {stage.dealCount === 1 ? "eligible deal" : "eligible deals"}</p></div>)}</div>}
  </SectionCard>;
}

/** Main B2B operations view. Its input comes only from the reportable-deals database view. */
export function B2bOperations({ snapshot = null, loadError }: { snapshot?: B2bDashboardSnapshot | null; loadError?: string }) {
  const [selectedStage, setSelectedStage] = useState("all");
  const stages = useMemo(() => snapshot ? [...new Set(snapshot.deals.map((deal) => deal.stage))].sort(compareStages) : [], [snapshot]);
  const visibleDeals = useMemo(() => snapshot?.deals.filter((deal) => selectedStage === "all" || deal.stage === selectedStage) ?? [], [selectedStage, snapshot]);

  return <AppShell title="B2B operations" description="Corporate pipeline, closed-won bookings, and recognised sales are tracked as separate financial concepts. Deals needing Admin review remain visible but are excluded from totals." controls={<div className="flex flex-wrap gap-2">{snapshot && <B2bPeriodSelector month={snapshot.period.month} />}<ManualDealEntry /></div>}>
    {loadError || !snapshot ? <ErrorState title="B2B data unavailable" description={loadError ?? "The B2B dashboard could not be loaded."} /> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Open pipeline" value={snapshot.openPipelineUsd} note="Current eligible open deals" />
        <MetricCard label={`Win rate · ${snapshot.period.monthLabel}`} value={snapshot.winRate?.percentage ?? "Not available"} note={snapshot.winRate ? `${snapshot.winRate.wonCount} won · ${snapshot.winRate.lostCount} lost, by close date` : "No eligible closed decisions with a close date"} />
        <MetricCard label={`Bookings · ${snapshot.period.quarterLabel}`} value={snapshot.bookingsThisQuarterUsd} note="Closed-won bookings only" />
        <MetricCard label={`Recognised sales · ${snapshot.period.monthLabel}`} value={snapshot.recognisedSalesThisMonthUsd ?? "Not yet recorded"} note={snapshot.recognisedSalesThisMonthUsd === null ? "Manual Finance entry required; separate from bookings" : "Separate from bookings"} />
      </div>
      <PipelineByStage stages={snapshot.pipelineByStage} />
      <SectionCard title="B2B deals" description="The selected period filters bookings and recognised sales. The table shows the total recognised amount recorded against each deal. Pipeline remains a current snapshot; historical pipeline cannot be reconstructed from a deal's current state. Issues are flagged for Admin review; only eligible deals contribute to totals." className="mt-4" action={snapshot.deals.length > 0 ? <label className="text-sm font-medium text-text-secondary">Stage<select aria-label="Filter B2B deals by stage" value={selectedStage} onChange={(event) => setSelectedStage(event.target.value)} className="mt-1 block h-10 min-w-44 rounded-input border border-border bg-surface px-3 text-sm text-text-primary focus:border-brand-accent focus:outline-none"><option value="all">All stages ({snapshot.deals.length})</option>{stages.map((stage) => <option key={stage} value={stage}>{stageLabel(stage)} ({snapshot.deals.filter((deal) => deal.stage === stage).length})</option>)}</select></label> : undefined}>
        {snapshot.deals.length === 0 ? <EmptyState title="No B2B deals yet" description="HubSpot deals will appear here after the first successful sync." /> : visibleDeals.length === 0 ? <EmptyState title="No deals in this stage" description="Choose another stage to see the remaining active B2B deals." /> : <DataTable caption="HubSpot B2B deals"><TableHead><TableHeader>Deal</TableHeader><TableHeader>Owner</TableHeader><TableHeader>Stage</TableHeader><TableHeader>Amount</TableHeader><TableHeader>Close date</TableHeader><TableHeader>Booking</TableHeader><TableHeader>Recognised sales</TableHeader><TableHeader>Renewal</TableHeader><TableHeader>Issue</TableHeader><TableHeader><span className="sr-only">Admin action</span></TableHeader></TableHead><tbody className="divide-y divide-line">{visibleDeals.map((deal) => <tr key={deal.id}><TableCell className="font-medium">{deal.name}</TableCell><TableCell>{deal.owner ?? "—"}</TableCell><TableCell>{stageLabel(deal.stage)}</TableCell><TableCell className="font-medium">{deal.amountUsd ? formatUsd(deal.amountUsd) : "Unavailable"}</TableCell><TableCell>{formatDate(deal.closeDate)}</TableCell><TableCell><StatusBadge status={deal.bookingStatus} /></TableCell><TableCell><RecognisedSalesCell status={deal.recognisedStatus} totalUsd={deal.recognisedTotalUsd} /></TableCell><TableCell>{formatDate(deal.renewalDate)}</TableCell><TableCell>{deal.issue ? <StatusBadge status={deal.issue} /> : "—"}</TableCell><TableCell><B2bDealAdminActions deal={deal} reportingPeriod={snapshot.period.monthStart} /></TableCell></tr>)}</tbody></DataTable>}
      </SectionCard>
    </>}
  </AppShell>;
}
