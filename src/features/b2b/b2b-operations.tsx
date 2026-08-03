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

/** Main B2B operations view. Its input comes only from the reportable-deals database view. */
export function B2bOperations({ snapshot = null, loadError }: { snapshot?: B2bDashboardSnapshot | null; loadError?: string }) {
  return <AppShell title="B2B operations" description="Corporate pipeline, closed-won bookings, and recognised sales are tracked as separate financial concepts. Deals needing Admin review remain visible but are excluded from totals." controls={<div className="flex flex-wrap gap-2">{snapshot && <B2bPeriodSelector month={snapshot.period.month} />}<ManualDealEntry /></div>}>
    {loadError || !snapshot ? <ErrorState title="B2B data unavailable" description={loadError ?? "The B2B dashboard could not be loaded."} /> : <>
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Open pipeline" value={snapshot.openPipelineUsd} note="Current eligible open deals" />
        <MetricCard label={`Bookings · ${snapshot.period.quarterLabel}`} value={snapshot.bookingsThisQuarterUsd} note="Closed-won bookings only" />
        <MetricCard label={`Recognised sales · ${snapshot.period.monthLabel}`} value={snapshot.recognisedSalesThisMonthUsd} note="Separate from bookings" />
      </div>
      <SectionCard title="B2B deals" description="The selected period filters bookings and recognised sales. Pipeline remains a current snapshot; historical pipeline cannot be reconstructed from a deal's current state. Issues are flagged for Admin review; only eligible deals contribute to totals." className="mt-4">
        {snapshot.deals.length === 0 ? <EmptyState title="No B2B deals yet" description="HubSpot deals will appear here after the first successful sync." /> : <DataTable caption="HubSpot B2B deals"><TableHead><TableHeader>Deal</TableHeader><TableHeader>Owner</TableHeader><TableHeader>Stage</TableHeader><TableHeader>Amount</TableHeader><TableHeader>Close date</TableHeader><TableHeader>Booking</TableHeader><TableHeader>Recognised sales</TableHeader><TableHeader>Renewal</TableHeader><TableHeader>Issue</TableHeader><TableHeader><span className="sr-only">Admin action</span></TableHeader></TableHead><tbody className="divide-y divide-line">{snapshot.deals.map((deal) => <tr key={deal.id}><TableCell className="font-medium">{deal.name}</TableCell><TableCell>{deal.owner ?? "—"}</TableCell><TableCell>{stageLabel(deal.stage)}</TableCell><TableCell className="font-medium">{deal.amountUsd ? formatUsd(deal.amountUsd) : "Unavailable"}</TableCell><TableCell>{formatDate(deal.closeDate)}</TableCell><TableCell><StatusBadge status={deal.bookingStatus} /></TableCell><TableCell><StatusBadge status={deal.recognisedStatus} /></TableCell><TableCell>{formatDate(deal.renewalDate)}</TableCell><TableCell>{deal.issue ? <StatusBadge status={deal.issue} /> : "—"}</TableCell><TableCell><B2bDealAdminActions deal={deal} /></TableCell></tr>)}</tbody></DataTable>}
      </SectionCard>
    </>}
  </AppShell>;
}
