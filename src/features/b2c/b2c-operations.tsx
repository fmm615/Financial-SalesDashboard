"use client";

import { AppShell } from "@/components/app-shell";
import { DataTable, EmptyState, ErrorState, MetricCard, SectionCard, StatusBadge, TableCell, TableHead, TableHeader } from "@/components/ui";
import { B2cPeriodSelector } from "@/features/b2c/b2c-period-selector";
import type { B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

/** B2C operations is a source ledger: refunds are separate, and source problems never become financial totals. */
export function B2cOperations({ snapshot = null, loadError }: { snapshot?: B2cDashboardSnapshot | null; loadError?: string }) {
  return <AppShell title="B2C operations" description="Stripe and other B2C payments are kept separate from B2B. Only completed, mapped, non-duplicate payments contribute to the reported totals; refunds remain separate source records." controls={snapshot ? <B2cPeriodSelector month={snapshot.period.month} /> : undefined}>
    {loadError || !snapshot ? <ErrorState title="B2C data unavailable" description={loadError ?? "The B2C dashboard could not be loaded."} /> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={`Eligible B2C payments · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.eligiblePaymentsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Succeeded, mapped payments only" : "No B2C source records have been received yet"} />
        <MetricCard label={`Refunds · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.refundsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Recorded separately from original payments" : "No B2C source records have been received yet"} />
        <MetricCard label={`Net B2C payments · ${snapshot.period.monthLabel}`} value={snapshot.hasSourceRecords ? snapshot.netPaymentsUsd : "Not loaded"} note={snapshot.hasSourceRecords ? "Eligible payments less eligible refunds; not recognised revenue" : "No B2C source records have been received yet"} />
        <MetricCard label="Items needing review" value={snapshot.hasSourceRecords ? String(snapshot.reviewItems) : "Not loaded"} note={snapshot.hasSourceRecords ? "Duplicates, unmapped products, failures, and refunds" : "No B2C source records have been received yet"} tone={snapshot.reviewItems > 0 ? "warning" : "neutral"} />
      </div>
      <SectionCard title={`B2C source ledger · ${snapshot.period.monthLabel}`} description="Provider IDs are retained for traceability. Payments with missing source details, an unmapped product, or a possible duplicate remain visible but are excluded from financial totals until an Admin completes the appropriate review." className="mt-4">
        {!snapshot.hasSourceRecords ? <EmptyState title="No B2C source records yet" description="Configure the Stripe webhook, send a test payment, or run the 48-hour reconciliation. PLAYBOOK will not display missing source data as zero." /> : snapshot.rows.length === 0 ? <EmptyState title="No B2C records in this month" description="Source records exist, but none occurred in the selected reporting month." /> : <DataTable caption="B2C source ledger"><TableHead><TableHeader>Customer</TableHeader><TableHeader>Mobile</TableHeader><TableHeader>Record</TableHeader><TableHeader>Date</TableHeader><TableHeader>Amount</TableHeader><TableHeader>Category</TableHeader><TableHeader>Tier</TableHeader><TableHeader>Source</TableHeader><TableHeader>Payment</TableHeader><TableHeader>Issue</TableHeader><TableHeader>Provider ID</TableHeader></TableHead><tbody className="divide-y divide-line">{snapshot.rows.map((row) => <tr key={`${row.recordType}-${row.id}`}><TableCell className="font-medium">{row.customerEmail ?? "—"}</TableCell><TableCell>{row.customerPhone ?? "—"}</TableCell><TableCell>{row.recordType}</TableCell><TableCell>{row.date}</TableCell><TableCell className="font-medium tabular-nums">{row.amountUsd}</TableCell><TableCell>{row.category}</TableCell><TableCell>{row.membershipTier ?? "—"}</TableCell><TableCell>{row.source}</TableCell><TableCell><StatusBadge status={row.paymentStatus} /></TableCell><TableCell>{row.issue ? <StatusBadge status={row.issue} /> : "—"}</TableCell><TableCell className="font-mono text-xs">{row.providerReference ?? "—"}</TableCell></tr>)}</tbody></DataTable>}
      </SectionCard>
    </>}
  </AppShell>;
}
