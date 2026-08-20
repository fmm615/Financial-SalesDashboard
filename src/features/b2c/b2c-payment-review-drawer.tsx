"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { PrimaryButton, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cBlockingReason } from "@/lib/b2c/payment-decision";
import type { B2cWorkItem } from "@/server/services/b2c-work-items";
import type { B2cPostedFinanceAdjustmentContext } from "@/server/services/adjust-b2c-finance-payment";
import type { PostedFinanceAdjustmentRequest } from "@/lib/validation/b2c-posted-adjustment-contracts";
import { B2cPaymentFinanceDecisionFragment, B2cPaymentLocalValuesFragment, type B2cReviewRow } from "@/features/b2c/b2c-payment-review-actions";
import { B2cRefundFxReviewActions } from "@/features/b2c/b2c-refund-fx-review-actions";
import { B2cSourceEvidencePanel } from "@/features/b2c/b2c-source-evidence-panel";
import { B2cAuditTimeline } from "@/features/b2c/b2c-audit-timeline";
import { B2cExactDuplicateReview } from "@/features/b2c/b2c-exact-duplicate-review";

export type B2cPaymentReviewDrawerTarget =
  | { kind: "row"; row: B2cReviewRow }
  | { kind: "workItem"; item: B2cWorkItem };

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";

/**
 * The one action a work item's `nextAction` (or, for a full ledger row, its
 * decision's first unresolved blocking reason) selects as prominent.
 * Everything else available renders under "More actions".
 */
type DrawerPrimaryAction =
  | "correct" | "map" | "convert_fx" | "review_exception"
  | "choose_duplicate" | "compare" | "review_import_version"
  | "posted_adjustment" | "retry_source" | "post"
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
  possible_duplicate: "choose_duplicate",
  unmatched_evidence: "compare",
  ambiguous_finance_lineage: "review_import_version",
};

/**
 * A posted Payment Tracker payment is corrected only through the append-only
 * Finance adjustment, never through the generic local-correction overlay --
 * regardless of which blocking reason (if any) is currently open on it.
 */
function primaryActionForRow(row: B2cReviewRow): DrawerPrimaryAction {
  if (row.recordType === "Refund") return row.isForeignCurrency ? "convert_fx" : null;
  if (row.recordType !== "Payment") return null;
  if (row.sourceSystem === "finance_tracker") return "posted_adjustment";
  for (const reason of row.decision?.blockingReasons ?? []) {
    const action = REASON_TO_ACTION[reason];
    if (action) return action;
  }
  return "correct";
}

function hasMeaningfulReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && !/^(?:-+|—+|n\/?a)$/i.test(trimmed);
}

/**
 * The drawer's posted-Finance-payment adjustment action. Reads the current
 * effective posted balance from the new Admin-only read, shows the
 * calculated effect before confirmation, and submits only the values the
 * Admin verified plus what the browser currently believes is true -- it
 * never constructs or signs the actual ledger delta itself. This is the
 * concrete path that would let an Admin correct a real posted payment like
 * Hoor Alshubbar's ($48.45, `85edf4fe-346b-483a-8053-199e6b1e2961`), whose
 * `2026-11-01` business date is a known implausible future date.
 */
function B2cPostedFinanceAdjustmentFragment({ paymentId, onSaved }: { paymentId: string; onSaved: () => void }) {
  const router = useRouter();
  const [context, setContext] = useState<B2cPostedFinanceAdjustmentContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifiedOccurredOn, setVerifiedOccurredOn] = useState("");
  const [verifiedAmountUsd, setVerifiedAmountUsd] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContext(null); setLoadError(null);
    fetch(`/api/admin/b2c/payments/${paymentId}/finance-adjustments`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { context?: B2cPostedFinanceAdjustmentContext; error?: string } | null;
        if (!response.ok || !payload?.context) throw new Error(payload?.error ?? "This posted B2C Finance payment could not be loaded.");
        return payload.context;
      })
      .then((loaded) => { if (!cancelled) setContext(loaded); })
      .catch((caught) => { if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "This posted B2C Finance payment could not be loaded."); });
    return () => { cancelled = true; };
  }, [paymentId]);

  if (loadError) return <p className="text-sm text-danger" role="alert">{loadError}</p>;
  if (!context) return <p className="text-sm text-text-muted">Loading the posted balance…</p>;

  const hasChange = Boolean(verifiedOccurredOn || verifiedAmountUsd);
  const effectiveDate = verifiedOccurredOn || context.currentOccurredOn;
  const effectiveAmount = verifiedAmountUsd || context.currentAmountUsd;

  async function submit() {
    setSaving(true); setMessage(null);
    const request: PostedFinanceAdjustmentRequest = {
      expectedOccurredOn: context!.currentOccurredOn,
      expectedAmountUsd: context!.currentAmountUsd,
      verifiedOccurredOn: verifiedOccurredOn || undefined,
      verifiedAmountUsd: verifiedAmountUsd || undefined,
      reason,
    };
    try {
      const response = await fetch(`/api/admin/b2c/payments/${paymentId}/finance-adjustments`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "This posted B2C Finance payment could not be adjusted.");
      router.refresh(); onSaved();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "This posted B2C Finance payment could not be adjusted. No source data was changed."); } finally { setSaving(false); }
  }

  return <div>
    <p className="text-sm leading-6 text-text-secondary">This Payment Tracker payment is already posted to Finance. A correction is an append-only signed adjustment -- the original posted entry is never rewritten.</p>
    <dl className="mt-4 grid gap-4 rounded-input border border-border bg-surface-muted/35 p-4 text-sm sm:grid-cols-2">
      <div><dt className="text-text-muted">Current posted amount</dt><dd className="mt-1 font-medium tabular-nums text-text-primary">{context.currentAmountUsd} USD</dd></div>
      <div><dt className="text-text-muted">Current posted date</dt><dd className="mt-1 font-medium text-text-primary">{context.currentOccurredOn}</dd></div>
    </dl>
    <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">
      <label className={fieldClass}>Corrected reporting date<input className={inputClass} type="date" value={verifiedOccurredOn} onChange={(event) => setVerifiedOccurredOn(event.target.value)} /></label>
      <label className={fieldClass}>Corrected amount (USD)<input className={inputClass} type="number" min="0.000001" step="0.000001" value={verifiedAmountUsd} onChange={(event) => setVerifiedAmountUsd(event.target.value)} /></label>
    </div>
    {hasChange && <p className="mt-3 rounded-input border border-brand-accent/25 bg-brand-accent/5 p-3 text-sm leading-6 text-text-secondary">This will record a signed adjustment changing the effective posted balance from <strong>{context.currentAmountUsd} USD on {context.currentOccurredOn}</strong> to <strong>{effectiveAmount} USD on {effectiveDate}</strong>.</p>}
    <label className={`${fieldClass} mt-4 block`}>Reason / evidence <span className="font-normal text-text-muted">(required)</span><textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence for this correction. It is saved in the audit history." /></label>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <PrimaryButton onClick={() => void submit()} disabled={saving || !hasChange || !hasMeaningfulReason(reason)}>{saving ? "Saving…" : "Record posted Finance adjustment"}</PrimaryButton>
      <p className="text-xs leading-5 text-text-muted">This calls the append-only database function; it never rewrites the original posted entry.</p>
    </div>
    {context.history.length > 0 && <p className="mt-3 text-xs text-text-muted">{context.history.length} prior adjustment{context.history.length === 1 ? "" : "s"} already recorded. See Audit history below for full detail.</p>}
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}

/** Picks and renders the one Finance-decision action a Payment or Refund row currently needs. */
function ActionSlot({ row, primary, onSaved }: { row: B2cReviewRow; primary: DrawerPrimaryAction; onSaved: () => void }) {
  if (row.recordType === "Refund") {
    if (!row.isForeignCurrency) return <p className="text-sm text-text-muted">This refund needs no further Finance decision.</p>;
    return <B2cRefundFxReviewActions row={row} onSaved={onSaved} />;
  }
  if (row.recordType !== "Payment") return <p className="text-sm text-text-muted">This is retained statement evidence only; it has no local action.</p>;
  if (primary === "posted_adjustment") return <B2cPostedFinanceAdjustmentFragment paymentId={row.id} onSaved={onSaved} />;
  // The pending Finance Tracker duplicate-decision review already renders
  // dialog-free and writes only through the existing per-group decision
  // route; the drawer reuses it directly rather than duplicating it.
  if (primary === "choose_duplicate") return <B2cExactDuplicateReview onGroupsChanged={async () => onSaved()} />;
  if (primary === "compare") return <p className="text-sm leading-6 text-text-muted">Retained provider evidence does not match this record. Provider sync, backfill, and import history are reviewed from Sources.</p>;
  if (primary === "review_import_version") return <p className="text-sm leading-6 text-text-muted">This Payment Tracker row needs an explicit new/revision/existing-payment decision. Payment Tracker import history is reviewed from Sources.</p>;
  if (primary === "retry_source") return <p className="text-sm leading-6 text-text-muted">Retry the failed provider sync from Sources.</p>;
  if (primary === "post") return <p className="text-sm leading-6 text-text-muted">Post approved Finance payments from the Work queue&rsquo;s Ready-to-post action.</p>;
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
 * FX, duplicate decision, and posted-adjustment action lives here, converted
 * to dialog-free fragments this drawer owns directly -- there is no separate
 * evidence dialog, edit modal, or refund-FX modal at the row level.
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
  // A save keeps the Admin in the same queue: it never removes the item
  // optimistically. Closing only happens after the server confirms the
  // write, at which point the Ledger/Work queue refetch on their own.
  function handleSaved() { onClose(); }

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

      {target.kind === "row" ? <RowSummary row={target.row} /> : <WorkItemSummary item={target.item} />}

      {target.kind === "row" && <>
        <Section title="Source evidence">
          <B2cSourceEvidencePanel paymentId={target.row.id} recordType={target.row.recordType} source={target.row.source} sourceSystem={target.row.sourceSystem} providerReference={target.row.providerReference} date={target.row.date} />
        </Section>

        {target.row.recordType === "Payment" && <Section title="Local values">
          {!canManage
            ? <ViewerReadOnlyNote />
            : target.row.sourceSystem === "finance_tracker"
              ? <p className="text-sm leading-6 text-text-muted">Payment Tracker payments are corrected only through the append-only Finance decision below -- never through a local overlay.</p>
              : <B2cPaymentLocalValuesFragment row={target.row} onSaved={handleSaved} />}
        </Section>}

        <Section title="Finance decision">
          {!canManage ? <ViewerReadOnlyNote /> : <ActionSlot row={target.row} primary={primaryActionForRow(target.row)} onSaved={handleSaved} />}
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
