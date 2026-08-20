"use client";

import { DataTable, StatusBadge, TableCell, TableHead, TableHeader } from "@/components/ui";
import type { B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";

export type B2cSafeLedgerRow = Omit<B2cDecoratedLedgerRow, "stripeEvidence">;

/**
 * Desktop columns cover customer, email, mobile, date, amount, source,
 * description (with a provider decline/seller message where one exists),
 * status, and next action. Provider IDs, plan, full evidence, and audit
 * history still live in the shared drawer, opened by the row's one `Review`
 * action. Mobile uses compact record cards instead of the fourteen-column table.
 */
export function B2cLedgerTable({ rows, onReview }: { rows: B2cSafeLedgerRow[]; onReview: (row: B2cSafeLedgerRow) => void }) {
  return <>
    <div className="hidden overflow-x-auto sm:block">
      <DataTable caption="B2C ledger">
        <TableHead>
          <TableHeader>Customer</TableHeader>
          <TableHeader>Email</TableHeader>
          <TableHeader>Mobile</TableHeader>
          <TableHeader>Date</TableHeader>
          <TableHeader>Amount</TableHeader>
          <TableHeader>Source</TableHeader>
          <TableHeader>Description</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader><span className="sr-only">Next action</span></TableHeader>
        </TableHead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => <tr key={`${row.recordType}-${row.id}`}>
            <TableCell className="font-medium">{row.customerName ?? "—"}</TableCell>
            <TableCell>{row.customerEmail ?? "—"}</TableCell>
            <TableCell>{row.customerPhone ?? "—"}</TableCell>
            <TableCell>{row.date}</TableCell>
            <TableCell className="font-medium tabular-nums">{row.amountUsd}</TableCell>
            <TableCell>{row.source}</TableCell>
            <TableCell>
              <span>{row.sourceDescription ?? "—"}</span>
              {row.sourceSellerMessage && <span className="mt-0.5 block text-xs text-warning">{row.sourceSellerMessage}</span>}
            </TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                {row.tapStatementUnmatched ? <span className="text-sm text-warning">Not matched to Tap API</span> : <StatusBadge status={row.paymentStatus} />}
                {row.issue && <StatusBadge status={row.issue} />}
              </div>
            </TableCell>
            <TableCell>
              {row.recordType === "Tap statement sale"
                ? <span className="text-xs text-text-muted">Statement evidence only</span>
                : <button type="button" onClick={() => onReview(row)} className="min-h-11 rounded-pill border border-border px-3 text-sm font-medium text-brand-accent hover:bg-surface-muted">Review</button>}
            </TableCell>
          </tr>)}
        </tbody>
      </DataTable>
    </div>

    <ul className="space-y-3 sm:hidden">
      {rows.map((row) => <li key={`${row.recordType}-${row.id}`} className="rounded-card border border-border bg-surface p-4 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-text-primary">{row.customerName ?? row.customerEmail ?? "—"}</p>
            <p className="mt-1 text-sm text-text-muted">{row.date} · {row.source}</p>
            {row.customerEmail && <p className="mt-0.5 truncate text-sm text-text-muted">{row.customerEmail}</p>}
            {row.customerPhone && <p className="mt-0.5 text-sm text-text-muted">{row.customerPhone}</p>}
          </div>
          <p className="shrink-0 font-medium tabular-nums text-text-primary">{row.amountUsd}</p>
        </div>
        {(row.sourceDescription || row.sourceSellerMessage) && <div className="mt-2 text-sm text-text-secondary">
          {row.sourceDescription && <p>{row.sourceDescription}</p>}
          {row.sourceSellerMessage && <p className="mt-0.5 text-warning">{row.sourceSellerMessage}</p>}
        </div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {row.tapStatementUnmatched ? <span className="text-sm text-warning">Not matched</span> : <StatusBadge status={row.paymentStatus} />}
            {row.issue && <StatusBadge status={row.issue} />}
          </div>
          {row.recordType !== "Tap statement sale" && <button type="button" onClick={() => onReview(row)} className="min-h-11 min-w-11 rounded-pill border border-border px-3 text-sm font-medium text-brand-accent hover:bg-surface-muted">Review</button>}
        </div>
      </li>)}
    </ul>
  </>;
}
