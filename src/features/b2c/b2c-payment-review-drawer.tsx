"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cBlockingReason } from "@/lib/b2c/payment-decision";
import type { B2cWorkItem } from "@/server/services/b2c-work-items";
import { B2cPaymentFinanceDecisionFragment, B2cPaymentLocalValuesFragment, type B2cReviewRow } from "@/features/b2c/b2c-payment-review-actions";
import { B2cRefundFxReviewActions } from "@/features/b2c/b2c-refund-fx-review-actions";
import { B2cSourceEvidencePanel } from "@/features/b2c/b2c-source-evidence-panel";
import { B2cAuditTimeline } from "@/features/b2c/b2c-audit-timeline";
import { B2cPaymentDuplicateReview } from "@/features/b2c/b2c-payment-duplicate-review";

export type B2cPaymentReviewDrawerTarget =
  | { kind: "row"; row: B2cReviewRow }
  | { kind: "workItem"; item: B2cWorkItem };

/**
 * The one action a work item's `nextAction` (or, for a full ledger row, its
 * decision's first unresolved blocking reason) selects as prominent.
 * Everything else available renders under "More actions".
 */
type DrawerPrimaryAction =
  | "correct" | "map" | "convert_fx" | "review_exception"
  | "choose_payment_duplicate" | "retry_source"
  | null;

/** Mirrors `REASON_PLAN` in `src/server/services/b2c-work-items.ts` (protected) so a Ledger-opened row picks the same primary action a Work-queue-opened item would. */
const REASON_TO_ACTION: Partial<Record<B2cBlockingReason, DrawerPrimaryAction>> = {
  missing_amount: "correct",
  missing_business_date: "correct",
  implausible_future_date: "correct",
  missing_customer_email: "correct",
  other_open_review: "correct",
  unmapped_category: "map",
  missing_fx: "convert_fx",
  possible_duplicate: "choose_payment_duplicate",
};

function primaryActionForRow(row: B2cReviewRow): DrawerPrimaryAction {
  if (row.recordType === "Refund") return row.isForeignCurrency ? "convert_fx" : null;
  if (row.recordType !== "Payment") return null;
  for (const reason of row.decision?.blockingReasons ?? []) {
    const action = REASON_TO_ACTION[reason];
    if (action) return action;
  }
  return "correct";
}

/** Picks and renders the one Finance-decision action a Payment or Refund row currently needs. */
function ActionSlot({ row, primary, onSaved, onPaymentDuplicateSaved }: { row: B2cReviewRow; primary: DrawerPrimaryAction; onSaved: () => void; onPaymentDuplicateSaved: (resolvedPaymentIds: string[]) => void }) {
  if (row.recordType === "Refund") {
    if (!row.isForeignCurrency) return <p className="text-sm text-text-muted">This refund needs no further Finance decision.</p>;
    return <B2cRefundFxReviewActions row={row} onSaved={onSaved} />;
  }
  if (primary === "choose_payment_duplicate") return <B2cPaymentDuplicateReview paymentId={row.id} onSaved={onPaymentDuplicateSaved} />;
  if (primary === "retry_source") return <p className="text-sm leading-6 text-text-muted">Retry the failed provider sync from Sources.</p>;
  const financeDecisionPrimary = primary === "map" || primary === "convert_fx" || primary === "review_exception" ? primary : null;
  return <B2cPaymentFinanceDecisionFragment row={row} primary={financeDecisionPrimary} onSaved={onSaved} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mt-6 border-t border-border pt-5">
    <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
    <div className="mt-2">{children}</div>
  </div>;
}

function ViewerReadOnlyNote() {
  return <p className="text-sm leading-6 text-text-muted">Viewer access is read-only. Only an Admin can take this action.</p>;
}

/**
 * The one shared record drawer. Work queue and Ledger both open this same
 * shell. Every correction, mapping, FX conversion, Finance exception, refund
 * FX, and duplicate decision action lives here, converted to dialog-free
 * fragments this drawer owns directly -- there is no separate evidence
 * dialog, edit modal, or refund-FX modal at the row level.
 */
export function B2cPaymentReviewDrawer({ target, onClose, onPaymentDuplicateResolved }: {
  target: B2cPaymentReviewDrawerTarget | null;
  onClose: () => void;
  onPaymentDuplicateResolved?: (resolvedPaymentIds: string[]) => void;
}) {
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

  const title = target.kind === "row"
    ? (target.row.customerName ?? target.row.customerEmail ?? "B2C record")
    : target.item.title;
  function handleSaved() { onClose(); }
  function handlePaymentDuplicateSaved(resolvedPaymentIds: string[]) {
    onPaymentDuplicateResolved?.(resolvedPaymentIds);
    onClose();
  }

  return <div className="fixed inset-0 z-50 overflow-hidden bg-brand-primary/30 p-4 sm:p-6" role="presentation" onMouseDown={onClose}>
    <section
      role="dialog" aria-modal="true" aria-labelledby="b2c-record-drawer-title"
      className="mx-auto my-4 max-h-[calc(100vh-2rem)] w-full max-w-[calc(100vw-2rem)] overflow-y-auto rounded-card bg-surface p-5 shadow-elevated sm:my-8 sm:max-h-[calc(100vh-4rem)] sm:max-w-xl sm:p-7 lg:max-w-2xl"
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

      {target.kind === "row" ? <RowSummary row={target.row} /> : target.kind === "workItem" ? <WorkItemSummary item={target.item} /> : null}

      {target.kind === "row" && <>
        <Section title="Source evidence">
          <B2cSourceEvidencePanel paymentId={target.row.id} recordType={target.row.recordType} source={target.row.source} sourceSystem={target.row.sourceSystem} providerReference={target.row.providerReference} date={target.row.date} />
        </Section>

        {target.row.recordType === "Payment" && <Section title="Local values">
          {!canManage ? <ViewerReadOnlyNote /> : <B2cPaymentLocalValuesFragment row={target.row} onSaved={handleSaved} />}
        </Section>}

        <Section title="Finance decision">
          {!canManage ? <ViewerReadOnlyNote /> : <ActionSlot row={target.row} primary={primaryActionForRow(target.row)} onSaved={handleSaved} onPaymentDuplicateSaved={handlePaymentDuplicateSaved} />}
        </Section>

        <Section title="Audit history"><B2cAuditTimeline recordId={target.row.id} /></Section>
      </>}

      {target.kind === "workItem" && <Section title="Finance decision">
        {!canManage ? <ViewerReadOnlyNote /> : <p className="text-sm leading-6 text-text-secondary">{target.item.explanation} Open this item from the Ledger once its record is loaded to review and act on the current values.</p>}
      </Section>}
    </section>
  </div>;
}

function RowSummary({ row }: { row: B2cReviewRow }) {
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
