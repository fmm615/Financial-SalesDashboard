"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";
import type { B2cWorkItem } from "@/server/services/b2c-work-items";
import { B2cPaymentReviewActions } from "@/features/b2c/b2c-payment-review-actions";
import { B2cRefundFxReviewActions } from "@/features/b2c/b2c-refund-fx-review-actions";

export type B2cPaymentReviewDrawerTarget =
  | { kind: "row"; row: Omit<B2cDecoratedLedgerRow, "stripeEvidence"> }
  | { kind: "workItem"; item: B2cWorkItem };

/**
 * The one shared record drawer. Work queue and Ledger both open this same
 * shell -- no separate evidence dialog, edit modal, or refund-FX modal
 * triggers live at the row level. This is a lightweight shell for Task 4:
 * full evidence and audit-history population is Task 5's job. Where a full
 * ledger row is available (opened from Ledger), it temporarily re-renders the
 * existing correction/exception/FX action components in its action slot so no
 * mutation capability regresses before Task 5 consolidates them into
 * dialog-free fragments.
 */
export function B2cPaymentReviewDrawer({ target, onClose }: { target: B2cPaymentReviewDrawerTarget | null; onClose: () => void }) {
  const canManage = useCanManage();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!target) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target ? (target.kind === "row" ? target.row.id : target.item.id) : null]);

  if (!target) return null;

  const title = target.kind === "row" ? (target.row.customerName ?? target.row.customerEmail ?? "B2C record") : target.item.title;

  return <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-primary/30 p-4 sm:p-6" role="presentation" onMouseDown={onClose}>
    <section
      role="dialog" aria-modal="true" aria-labelledby="b2c-record-drawer-title"
      className="mx-auto my-4 w-full max-w-[calc(100vw-2rem)] overflow-hidden overflow-y-auto rounded-card bg-surface p-5 shadow-elevated sm:my-8 sm:max-w-xl sm:p-7 lg:max-w-2xl"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Record</p>
          <h2 id="b2c-record-drawer-title" className="mt-1 text-xl font-semibold text-text-primary">{title}</h2>
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close record drawer" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill text-text-secondary hover:bg-surface-muted hover:text-text-primary">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {target.kind === "row" ? <RowSummary row={target.row} /> : <WorkItemSummary item={target.item} />}

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-text-primary">Next action</h3>
        {!canManage ? <p className="mt-2 text-sm leading-6 text-text-muted">Viewer access is read-only. Only an Admin can take the next action.</p> : target.kind === "row" ? <ActionSlot row={target.row} /> : <p className="mt-2 text-sm leading-6 text-text-secondary">{target.item.explanation} Open this item from the Ledger once its record is loaded to review and act on the current values.</p>}
      </div>
    </section>
  </div>;
}

function RowSummary({ row }: { row: Omit<B2cDecoratedLedgerRow, "stripeEvidence"> }) {
  return <dl className="mt-6 grid gap-4 rounded-card border border-border bg-surface-muted/35 p-4 text-sm sm:grid-cols-2">
    <div><dt className="text-text-muted">Customer</dt><dd className="mt-1 font-medium text-text-primary">{row.customerName ?? "—"}</dd></div>
    <div><dt className="text-text-muted">Email</dt><dd className="mt-1 text-text-secondary">{row.customerEmail ?? "—"}</dd></div>
    <div><dt className="text-text-muted">Date</dt><dd className="mt-1 text-text-secondary">{row.date}</dd></div>
    <div><dt className="text-text-muted">Amount</dt><dd className="mt-1 font-medium tabular-nums text-text-primary">{row.amountUsd}</dd></div>
    <div><dt className="text-text-muted">Source</dt><dd className="mt-1 text-text-secondary">{row.source}</dd></div>
    <div><dt className="text-text-muted">Status</dt><dd className="mt-1"><StatusBadge status={row.paymentStatus} /></dd></div>
    <div><dt className="text-text-muted">Category</dt><dd className="mt-1 text-text-secondary">{row.category}</dd></div>
    <div><dt className="text-text-muted">Provider reference</dt><dd className="mt-1 break-all font-mono text-xs text-text-secondary">{row.providerReference ?? "—"}</dd></div>
    {row.decision && <div className="sm:col-span-2"><dt className="text-text-muted">Reporting decision</dt><dd className="mt-1 leading-6 text-text-secondary">{row.decision.explanation}</dd></div>}
  </dl>;
}

function WorkItemSummary({ item }: { item: B2cWorkItem }) {
  return <dl className="mt-6 grid gap-4 rounded-card border border-border bg-surface-muted/35 p-4 text-sm">
    <div><dt className="text-text-muted">What needs attention</dt><dd className="mt-1 leading-6 text-text-secondary">{item.explanation}</dd></div>
    {item.financialImpactUsd && <div><dt className="text-text-muted">Financial impact</dt><dd className="mt-1 font-medium tabular-nums text-text-primary">{item.financialImpactUsd}</dd></div>}
  </dl>;
}

/**
 * Bridges the existing correction/exception/FX action components into the
 * shared shell. `row` is missing only the Admin-only `stripeEvidence` field,
 * which none of these components read, so it satisfies their optional field.
 * Task 5 converts these into dialog-free fragments the drawer owns directly.
 */
function ActionSlot({ row }: { row: Omit<B2cDecoratedLedgerRow, "stripeEvidence"> }) {
  if (row.recordType === "Payment") return <div className="mt-2"><B2cPaymentReviewActions row={row as B2cLedgerRow} /></div>;
  if (row.recordType === "Refund") return <div className="mt-2"><B2cRefundFxReviewActions row={row as B2cLedgerRow} /></div>;
  return <p className="mt-2 text-sm leading-6 text-text-muted">This is retained statement evidence only; it has no local action.</p>;
}
