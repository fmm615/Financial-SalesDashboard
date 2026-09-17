"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cBlockingReason } from "@/lib/b2c/payment-decision";
import type { B2cWorkItem } from "@/server/services/b2c-work-items";
import {
  B2cPaymentAmountCorrection,
  B2cPaymentBusinessDateCorrection,
  B2cPaymentEmailCorrection,
  B2cPaymentFinanceException,
  B2cPaymentFxConversion,
  B2cPaymentOtherDetailsCorrection,
  type B2cReviewRow,
} from "@/features/b2c/b2c-payment-review-actions";
import { B2cRefundFxReviewActions } from "@/features/b2c/b2c-refund-fx-review-actions";
import { B2cSourceEvidencePanel } from "@/features/b2c/b2c-source-evidence-panel";
import { B2cAuditTimeline } from "@/features/b2c/b2c-audit-timeline";
import { B2cPaymentDuplicateReview } from "@/features/b2c/b2c-payment-duplicate-review";

export type B2cPaymentReviewDrawerTarget =
  | { kind: "row"; row: B2cReviewRow }
  | { kind: "workItem"; item: B2cWorkItem };

const REASON_CONTENT: Record<B2cBlockingReason, { title: string; explanation: string }> = {
  missing_amount: {
    title: "Missing amount",
    explanation: "This payment has no verified USD amount, so Finance needs one before it can be reported.",
  },
  missing_business_date: {
    title: "Missing business date",
    explanation: "This payment needs a verified business date before it can be placed in the right reporting period.",
  },
  implausible_future_date: {
    title: "Business date looks wrong",
    explanation: "The current business date is in the future and needs a verified correction.",
  },
  missing_customer_email: {
    title: "Missing customer email",
    explanation: "The provider did not supply a verified transaction email for this payment.",
  },
  missing_fx: {
    title: "Needs currency conversion",
    explanation: "This foreign-currency payment needs a Finance-approved USD conversion before reporting.",
  },
  possible_duplicate: {
    title: "Possible duplicate",
    explanation: "This payment matches another record and needs an audited duplicate decision.",
  },
  duplicate_exclusion: {
    title: "Excluded as duplicate",
    explanation: "An audited duplicate decision excludes this payment from Finance reporting.",
  },
  failed_payment: {
    title: "Payment failed",
    explanation: "This payment did not succeed, so it stays out of Finance reporting.",
  },
  pending_payment: {
    title: "Payment pending",
    explanation: "This payment has not yet succeeded, so it stays out of Finance reporting.",
  },
  other_open_review: {
    title: "Open review item",
    explanation: "This record has an open review flag that does not yet have a drawer action.",
  },
};

const REPORTING_STATUS_LABEL: Record<B2cReviewRow["decision"]["reportingDecision"], string> = {
  reportable: "Reportable",
  blocked: "Blocked",
  excluded: "Excluded",
  exception_included: "Included by exception",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mt-6 border-t border-border pt-5">
    <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
    <div className="mt-3">{children}</div>
  </div>;
}

function ViewerReadOnlyNote() {
  return <p className="text-sm leading-6 text-text-muted">Viewer access is read-only. Only an Admin can take this action.</p>;
}

function NeedCard({ title, explanation, defaultOpen, children }: {
  title: string;
  explanation: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  return <details open={defaultOpen} className="group overflow-hidden rounded-card border border-border bg-surface shadow-card">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-accent">
      <span className="font-semibold text-text-primary">{title}</span>
      <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-text-muted transition-transform group-open:rotate-180" />
    </summary>
    <div className="border-t border-border px-4 py-4">
      <p className="text-sm leading-6 text-text-secondary">{explanation}</p>
      <div className="mt-4">{children}</div>
    </div>
  </details>;
}

function NoActionState({ tag = "No action needed", children }: { tag?: string; children?: ReactNode }) {
  return <div>
    <StatusBadge status={tag} />
    {children && <div className="mt-3 text-sm leading-6 text-text-secondary">{children}</div>}
  </div>;
}

function OtherOpenReviewState({ row }: { row: B2cReviewRow }) {
  const reasons = row.openReviewFlags
    .filter((flag) => flag.type === "Needs follow-up")
    .map((flag) => ({ id: flag.id, reason: flag.reason }));

  return <NoActionState tag="No action needed here yet">
    {reasons.length > 0
      ? <ul className="space-y-2">{reasons.map((flag) => <li key={flag.id} className="rounded-input border border-border bg-surface-muted/35 p-3">{flag.reason}</li>)}</ul>
      : <p>{row.decision.explanation}</p>}
  </NoActionState>;
}

function PaymentReasonAction({ row, reason, onSaved, onPaymentDuplicateSaved }: {
  row: B2cReviewRow;
  reason: B2cBlockingReason;
  onSaved: () => void;
  onPaymentDuplicateSaved: (resolvedPaymentIds: string[]) => void;
}) {
  const canManage = useCanManage();

  if (reason === "duplicate_exclusion") {
    return <NoActionState><p>{canManage
      ? row.duplicateExclusionReason ?? row.decision.explanation
      : row.decision.explanation}</p></NoActionState>;
  }
  if (reason === "failed_payment" || reason === "pending_payment") {
    return <NoActionState />;
  }
  if (reason === "other_open_review") {
    return <OtherOpenReviewState row={row} />;
  }
  if (!canManage) return <ViewerReadOnlyNote />;

  if (reason === "missing_amount") return <B2cPaymentAmountCorrection row={row} onSaved={onSaved} />;
  if (reason === "missing_business_date") return <B2cPaymentBusinessDateCorrection row={row} saveLabel="Save date" onSaved={onSaved} />;
  if (reason === "implausible_future_date") return <B2cPaymentBusinessDateCorrection row={row} saveLabel="Save corrected date" onSaved={onSaved} />;
  if (reason === "missing_fx") return <B2cPaymentFxConversion row={row} onSaved={onSaved} />;
  if (reason === "possible_duplicate") return <B2cPaymentDuplicateReview paymentId={row.id} onSaved={onPaymentDuplicateSaved} />;

  return <div className="space-y-5">
    <B2cPaymentEmailCorrection row={row} onSaved={onSaved} />
    <details className="group overflow-hidden rounded-input border border-brand-accent/25 bg-brand-accent/5">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-accent">
        <span>Include without email</span>
        <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-brand-accent/15 px-4 py-4">
        <B2cPaymentFinanceException row={row} onSaved={onSaved} />
      </div>
    </details>
  </div>;
}

function BlockingReasonCards({ row, onSaved, onPaymentDuplicateSaved }: {
  row: B2cReviewRow;
  onSaved: () => void;
  onPaymentDuplicateSaved: (resolvedPaymentIds: string[]) => void;
}) {
  const canManage = useCanManage();

  if (row.recordType === "Refund") {
    if (!row.isForeignCurrency) {
      return <NeedCard title="Refund review complete" explanation="This refund needs no further Finance decision." defaultOpen>
        <NoActionState />
      </NeedCard>;
    }
    return <NeedCard title="Needs currency conversion" explanation="This foreign-currency refund needs a Finance-approved USD conversion before reporting." defaultOpen>
      {canManage ? <B2cRefundFxReviewActions row={row} onSaved={onSaved} /> : <ViewerReadOnlyNote />}
    </NeedCard>;
  }

  const reasons = row.decision.blockingReasons;
  const otherDetailsCard = <NeedCard
    key="other-details"
    title="Other details"
    explanation="Optional metadata that isn't required for this record to be reportable."
    defaultOpen={false}
  >
    {canManage ? <B2cPaymentOtherDetailsCorrection row={row} onSaved={onSaved} /> : <ViewerReadOnlyNote />}
  </NeedCard>;

  if (reasons.length === 0) {
    return <div className="space-y-3">
      <div className="rounded-card border border-success/25 bg-success/5 p-4">
        <p className="font-semibold text-success">Ready to report — nothing needed</p>
        <p className="mt-2 text-sm leading-6 text-text-secondary">This record has no unresolved blocking reasons.</p>
      </div>
      {otherDetailsCard}
    </div>;
  }

  return <div className="space-y-3">
    {reasons.map((reason, index) => <NeedCard
      key={reason}
      title={REASON_CONTENT[reason].title}
      explanation={REASON_CONTENT[reason].explanation}
      defaultOpen={index === 0}
    >
      <PaymentReasonAction row={row} reason={reason} onSaved={onSaved} onPaymentDuplicateSaved={onPaymentDuplicateSaved} />
    </NeedCard>)}
    {otherDetailsCard}
  </div>;
}

function EvidenceAndHistoryDisclosure({ row }: { row: B2cReviewRow }) {
  return <details className="group mt-6 overflow-hidden rounded-card border border-border bg-surface-muted/25">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-accent">
      <span>Show source evidence &amp; history</span>
      <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-text-muted transition-transform group-open:rotate-180" />
    </summary>
    <div className="space-y-6 border-t border-border px-4 py-5">
      <section aria-labelledby="b2c-source-evidence-title">
        <h3 id="b2c-source-evidence-title" className="text-sm font-semibold text-text-primary">Source evidence</h3>
        <div className="mt-3">
          <B2cSourceEvidencePanel paymentId={row.id} recordType={row.recordType} source={row.source} sourceSystem={row.sourceSystem} providerReference={row.providerReference} date={row.date} />
        </div>
      </section>
      <section className="border-t border-border pt-5" aria-labelledby="b2c-audit-history-title">
        <h3 id="b2c-audit-history-title" className="text-sm font-semibold text-text-primary">Audit history</h3>
        <div className="mt-3"><B2cAuditTimeline recordId={row.id} /></div>
      </section>
    </div>
  </details>;
}

/**
 * The one shared record drawer. Work queue and Ledger both open this shell.
 * A full row lists every unresolved reason in canonical order; deep-linked
 * work items keep their existing redirect prompt until the row is loaded.
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
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close record drawer" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill text-text-secondary hover:bg-surface-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {target.kind === "row" ? <RowSummary row={target.row} /> : target.kind === "workItem" ? <WorkItemSummary item={target.item} /> : null}

      {target.kind === "row" && <>
        <Section title="What this record needs">
          <BlockingReasonCards row={target.row} onSaved={handleSaved} onPaymentDuplicateSaved={handlePaymentDuplicateSaved} />
        </Section>
        <EvidenceAndHistoryDisclosure row={target.row} />
      </>}

      {target.kind === "workItem" && <Section title="Finance decision">
        {!canManage ? <ViewerReadOnlyNote /> : <p className="text-sm leading-6 text-text-secondary">{target.item.explanation} Open this item from the Ledger once its record is loaded to review and act on the current values.</p>}
      </Section>}
    </section>
  </div>;
}

function RowSummary({ row }: { row: B2cReviewRow }) {
  return <dl className="mt-6 grid gap-4 rounded-card border border-border bg-surface-muted/35 p-4 text-sm sm:grid-cols-2">
    <div><dt className="text-text-muted">Customer</dt><dd className="mt-1 font-medium text-text-primary">{row.customerName ?? "—"}</dd>{row.customerNameEvidenceLabel && <p className="mt-0.5 text-xs font-medium text-warning">From {row.customerNameEvidenceLabel} — not yet verified</p>}</div>
    <div><dt className="text-text-muted">Email</dt><dd className="mt-1 text-text-secondary">{row.customerEmail ?? "—"}</dd>{row.customerEmailEvidenceLabel && <p className="mt-0.5 text-xs font-medium text-warning">From {row.customerEmailEvidenceLabel} — not yet verified</p>}</div>
    <div><dt className="text-text-muted">Date</dt><dd className="mt-1 text-text-secondary">{row.date}</dd></div>
    <div><dt className="text-text-muted">Amount</dt><dd className="mt-1 font-medium tabular-nums text-text-primary">{row.amountUsd}</dd></div>
    <div><dt className="text-text-muted">Source</dt><dd className="mt-1 text-text-secondary">{row.source}</dd></div>
    <div><dt className="text-text-muted">Status</dt><dd className="mt-1"><StatusBadge status={row.paymentStatus} /></dd></div>
    <div><dt className="text-text-muted">Provider reference</dt><dd className="mt-1 break-all font-mono text-xs text-text-secondary">{row.providerReference ?? "—"}</dd></div>
    <div><dt className="text-text-muted">Reporting decision</dt><dd className="mt-1"><StatusBadge status={REPORTING_STATUS_LABEL[row.decision.reportingDecision]} /></dd></div>
  </dl>;
}

function WorkItemSummary({ item }: { item: B2cWorkItem }) {
  return <dl className="mt-6 grid gap-4 rounded-card border border-border bg-surface-muted/35 p-4 text-sm">
    <div><dt className="text-text-muted">What needs attention</dt><dd className="mt-1 leading-6 text-text-secondary">{item.explanation}</dd></div>
    {item.financialImpactUsd && <div><dt className="text-text-muted">Financial impact</dt><dd className="mt-1 font-medium tabular-nums text-text-primary">{item.financialImpactUsd}</dd></div>}
  </dl>;
}
