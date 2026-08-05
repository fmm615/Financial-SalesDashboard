"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";
// Review copy can contain provider-supplied values and long audit explanations.
// Keep it inside the modal at every viewport size instead of clipping it.
const copyClass = "min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]";

type CorrectionDraft = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  categoryCode: string;
  membershipTier: string;
  amountUsd: string;
  occurredOn: string;
};

function draftFromRow(row: B2cLedgerRow): CorrectionDraft {
  return {
    customerName: row.customerName ?? "",
    customerEmail: row.customerEmail ?? "",
    customerPhone: row.customerPhone ?? "",
    categoryCode: row.category === "Unmapped" ? "unmapped" : row.category,
    membershipTier: row.membershipTier ?? "",
    // Numeric PostgreSQL values can be serialised as numbers by a Supabase
    // client even though the UI domain formats money as text. Form state must
    // always be text so the change comparison and input controls stay safe.
    amountUsd: String(row.amountValueUsd),
    occurredOn: String(row.dateValue),
  };
}

function isChanged(value: string | number | null | undefined, current: string | number | null | undefined, normalise?: (candidate: string) => string): boolean {
  const transform = normalise ?? ((candidate: string) => candidate.trim());
  return transform(String(value ?? "")) !== transform(String(current ?? ""));
}

/** Admin-only local correction controls. They use Supabase RLS and never call Stripe. */
export function B2cPaymentReviewActions({ row }: { row: B2cLedgerRow }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [internalProductCode, setInternalProductCode] = useState("");
  const [internalProductName, setInternalProductName] = useState("");
  const [mappingCategoryCode, setMappingCategoryCode] = useState("");
  const [mappingMembershipTier, setMappingMembershipTier] = useState("");
  const [draft, setDraft] = useState<CorrectionDraft>(() => draftFromRow(row));
  const [reason, setReason] = useState("");
  const [confirmedProviderTransaction, setConfirmedProviderTransaction] = useState(false);
  const [confirmedNoKnownDuplicate, setConfirmedNoKnownDuplicate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Refunds are separate immutable source records. This workflow corrects the
  // linked payment's local reporting overlay, not a provider refund.
  if (!canManage || row.recordType !== "Payment") return null;

  const hasUnmappedProduct = row.openReviewFlags.some((flag) => flag.type === "Unmapped product");
  const mappingAvailable = row.sourceSystem === "stripe" && Boolean(row.productReference);
  const current = draftFromRow(row);
  const correction = {
    customerName: isChanged(draft.customerName, current.customerName) ? draft.customerName.trim() : undefined,
    customerEmail: isChanged(draft.customerEmail, current.customerEmail, (value) => value.trim().toLowerCase()) ? draft.customerEmail.trim().toLowerCase() : undefined,
    customerPhone: isChanged(draft.customerPhone, current.customerPhone) ? draft.customerPhone.trim() : undefined,
    categoryCode: isChanged(draft.categoryCode, current.categoryCode, (value) => value.trim().toLowerCase()) ? draft.categoryCode.trim().toLowerCase() : undefined,
    membershipTier: isChanged(draft.membershipTier, current.membershipTier) ? draft.membershipTier.trim() : undefined,
    amountUsd: isChanged(draft.amountUsd, current.amountUsd) ? draft.amountUsd.trim() : undefined,
    occurredOn: isChanged(draft.occurredOn, current.occurredOn) ? draft.occurredOn : undefined,
  };
  const hasLocalCorrectionInput = Object.values(correction).some(Boolean);

  function openReview() {
    setDraft(draftFromRow(row));
    setReason("");
    setConfirmedProviderTransaction(false);
    setConfirmedNoKnownDuplicate(false);
    setMessage(null);
    setOpen(true);
  }

  function updateDraft<Key extends keyof CorrectionDraft>(key: Key, value: CorrectionDraft[Key]) {
    setDraft((currentDraft) => ({ ...currentDraft, [key]: value }));
  }

  async function mapProduct() {
    if (!row.productReference) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/b2c/stripe-products/map", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productReference: row.productReference, internalProductCode, internalProductName, categoryCode: mappingCategoryCode, membershipTier: mappingMembershipTier || undefined, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local Stripe product mapping could not be saved.");
      setOpen(false); router.refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The local Stripe product mapping could not be saved."); } finally { setSaving(false); }
  }

  async function saveFinanceException() {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/finance-exception`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, confirmedProviderTransaction, confirmedNoKnownDuplicate }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Finance exception could not be saved.");
      setOpen(false); router.refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The Finance exception could not be saved."); } finally { setSaving(false); }
  }

  async function saveLocalCorrection() {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/payments/${row.id}/correct`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...correction, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local B2C correction could not be saved.");
      setOpen(false); router.refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The local B2C correction could not be saved."); } finally { setSaving(false); }
  }

  const canUseFinanceException = row.paymentStatus === "Completed" && Boolean(row.providerReference) && row.category !== "Unmapped" && !row.hasFinanceException;
  const hasSourceReview = row.openReviewFlags.length > 0;
  const financeExceptionSourceGaps = Array.from(new Set(row.openReviewFlags.flatMap((flag) => {
    if (flag.type === "Missing customer email") return ["customer email"];
    if (flag.type === "Unmapped product") return ["approved product mapping"];
    return [];
  })));
  const showFinanceException = row.hasFinanceException || financeExceptionSourceGaps.length > 0;

  return <>
    <button type="button" onClick={openReview} className="font-medium text-brand-accent hover:underline">Edit locally</button>
    {open && <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-primary/30 p-4 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={`b2c-review-${row.id}`} className="mx-auto my-4 w-full min-w-0 max-w-[calc(100vw-2rem)] overflow-hidden whitespace-normal rounded-card bg-surface p-5 shadow-elevated sm:my-8 sm:max-w-[calc(100vw-3rem)] sm:p-8 lg:max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 id={`b2c-review-${row.id}`} className="text-xl font-semibold text-text-primary sm:text-2xl">Correct B2C payment</h2><StatusBadge status={row.paymentStatus} /></div>
            <p className={`${copyClass} mt-1 max-w-2xl text-sm leading-6 text-text-muted`}>Save verified local values with a reason. Stripe is never changed.</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close B2C payment editor" className="shrink-0 rounded-pill px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted hover:text-text-primary">Close</button>
        </div>

        <div className="mt-6 rounded-card border border-border bg-surface-muted/35 p-4 sm:p-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"><div><h3 className="font-semibold text-text-primary">Verified local values</h3><p className={`${copyClass} mt-1 text-sm leading-6 text-text-muted`}>Update only the values Finance has verified.</p></div><p className="text-xs text-text-muted">Source amount: {row.sourceAmountUsd} · Source date: {row.sourceDateValue}</p></div>
          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Customer</p>
            <div className="mt-3 grid gap-x-5 gap-y-4 md:grid-cols-2">
            <label className={fieldClass}>Customer name<input className={inputClass} value={draft.customerName} onChange={(event) => updateDraft("customerName", event.target.value)} placeholder="Verified customer name" /></label>
            <label className={fieldClass}>Customer email<input className={inputClass} value={draft.customerEmail} onChange={(event) => updateDraft("customerEmail", event.target.value)} inputMode="email" placeholder="verified@example.com" /></label>
            <label className={fieldClass}>Customer mobile<input className={inputClass} value={draft.customerPhone} onChange={(event) => updateDraft("customerPhone", event.target.value)} inputMode="tel" placeholder="+973 0000 0000" /></label>
            </div>
          </div>
          <div className="mt-5 border-t border-border pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">PLAYBOOK reporting</p>
            <div className="mt-3 grid gap-x-5 gap-y-4 md:grid-cols-2">
            <label className={fieldClass}>PLAYBOOK reporting category<input className={inputClass} value={draft.categoryCode} onChange={(event) => updateDraft("categoryCode", event.target.value)} placeholder="membership" /></label>
            <label className={fieldClass}>Plan / tier<input className={inputClass} value={draft.membershipTier} onChange={(event) => updateDraft("membershipTier", event.target.value)} placeholder="Founding Membership" /></label>
            <label className={fieldClass}>Local B2C amount (USD)<input className={inputClass} type="number" min="0.000001" step="0.000001" value={draft.amountUsd} onChange={(event) => updateDraft("amountUsd", event.target.value)} /></label>
            <label className={fieldClass}>Local business date<input className={inputClass} type="date" value={draft.occurredOn} onChange={(event) => updateDraft("occurredOn", event.target.value)} /></label>
            </div>
          </div>
        </div>

        <label className={`${fieldClass} mt-5`}>Reason / evidence <span className="font-normal text-text-muted">(required)</span><textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence for this change. It is saved in the audit history." /></label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={() => void saveLocalCorrection()} disabled={saving || !hasLocalCorrectionInput || reason.trim().length < 3}>{saving ? "Saving…" : "Save audited local correction"}</PrimaryButton>
          <p className="text-xs leading-5 text-text-muted">{hasLocalCorrectionInput ? "The saved correction updates PLAYBOOK reporting only." : "Change at least one local value and enter a reason to save."}</p>
        </div>

        <div className="mt-6 space-y-3 border-t border-border pt-5">
          <details className="group rounded-input border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>Source details</span><span className="text-xs font-normal text-text-muted group-open:hidden">View</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
            <div className="grid gap-x-6 gap-y-4 border-t border-border px-4 py-4 text-sm sm:grid-cols-2">
              <p className="min-w-0"><span className="text-text-muted">Stripe payment ID</span><span className="mt-1 block break-all font-mono text-xs text-text-primary">{row.providerReference ?? "Unavailable"}</span></p>
              <p className="min-w-0"><span className="text-text-muted">Stripe source product</span><span className={`${copyClass} mt-1 block font-medium text-text-primary`}>{row.productReference ?? "Unavailable from Stripe"}</span></p>
              <p><span className="text-text-muted">Provider status</span><span className="mt-1 block"><StatusBadge status={row.paymentStatus} /></span></p>
              <p><span className="text-text-muted">Provider source</span><span className="mt-1 block font-medium text-text-primary">{row.source}</span></p>
            </div>
          </details>

          {hasSourceReview && <details className="group rounded-input border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>Source review flags <span className="ml-1 font-normal text-text-muted">({row.openReviewFlags.length})</span></span><span className="text-xs font-normal text-text-muted group-open:hidden">View</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
            <div className="border-t border-border px-4 py-4">
              <p className={`${copyClass} text-sm leading-6 text-text-muted`}>These source flags remain in history. A verified local correction clears only its matching missing-data flag; Stripe is never changed.</p>
              <div className="mt-4 space-y-3">
                {row.openReviewFlags.map((flag) => <div key={flag.id} className="min-w-0 max-w-full rounded-input border border-border bg-surface-muted/35 p-4"><StatusBadge status={flag.type} /><p className={`${copyClass} mt-3 text-sm leading-6 text-text-secondary`}>{flag.reason}</p></div>)}
              </div>
              {hasUnmappedProduct && !mappingAvailable && <p className={`${copyClass} mt-4 rounded-input border border-warning/25 bg-warning/5 p-3 text-sm leading-6 text-warning`}>Stripe did not provide a reusable product reference. A local correction above affects this payment only.</p>}
            </div>
          </details>}

          {hasUnmappedProduct && mappingAvailable && <details className="group rounded-input border border-warning/25 bg-warning/5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>Create reusable product mapping</span><span className="text-xs font-normal text-warning group-open:hidden">Optional</span><span className="hidden text-xs font-normal text-warning group-open:inline">Hide</span></summary>
            <div className="border-t border-warning/20 px-4 py-4"><p className={`${copyClass} text-sm leading-6 text-text-secondary`}>This classifies every local payment with this exact source product reference. It does not edit Stripe.</p><div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2"><label className={fieldClass}>Internal product code<input className={inputClass} value={internalProductCode} onChange={(event) => setInternalProductCode(event.target.value)} placeholder="membership_annual" /></label><label className={fieldClass}>Internal product name<input className={inputClass} value={internalProductName} onChange={(event) => setInternalProductName(event.target.value)} placeholder="Annual membership" /></label><label className={fieldClass}>PLAYBOOK reporting category<input className={inputClass} value={mappingCategoryCode} onChange={(event) => setMappingCategoryCode(event.target.value)} placeholder="membership" /></label><label className={fieldClass}>Membership tier <span className="font-normal text-text-muted">(optional)</span><input className={inputClass} value={mappingMembershipTier} onChange={(event) => setMappingMembershipTier(event.target.value)} placeholder="annual" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void mapProduct()} disabled={saving || reason.trim().length < 3}>{saving ? "Saving…" : "Save local product mapping"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">Uses the reason above and applies only in PLAYBOOK.</p></div></div>
          </details>}

          {showFinanceException && <details className="group rounded-input border border-brand-accent/25 bg-brand-accent/5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-text-primary marker:content-none"><span>{row.hasFinanceException ? "Finance inclusion exception" : "Count in Finance despite missing source details"}</span><span className="text-xs font-normal text-text-muted group-open:hidden">Advanced</span><span className="hidden text-xs font-normal text-text-muted group-open:inline">Hide</span></summary>
            <div className="border-t border-brand-accent/15 px-4 py-4">{row.hasFinanceException ? <p className={`${copyClass} text-sm leading-6 text-success`}>This payment is included in PLAYBOOK Finance through an audited exception. The original missing Stripe source details remain visible in its history.</p> : <><p className={`${copyClass} text-sm leading-6 text-text-secondary`}>This payment is currently excluded because Stripe did not provide: <strong className="font-semibold text-text-primary">{financeExceptionSourceGaps.join(" and ")}</strong>.</p><p className={`${copyClass} mt-2 text-sm leading-6 text-text-secondary`}>First, save the verified local value above if you have it. Use this only when the source detail is genuinely unavailable but Finance has still verified the amount, business date, and PLAYBOOK category.</p>{!canUseFinanceException && <p className="mt-3 rounded-input border border-warning/25 bg-warning/5 p-3 text-sm leading-6 text-warning">Save a verified local PLAYBOOK category above before this payment can be included by exception.</p>}<label className="mt-4 flex items-start gap-3 text-sm leading-5 text-text-secondary"><input type="checkbox" checked={confirmedProviderTransaction} onChange={(event) => setConfirmedProviderTransaction(event.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-border text-brand-accent" />I confirm this is the exact provider payment ID shown above.</label><label className="mt-3 flex items-start gap-3 text-sm leading-5 text-text-secondary"><input type="checkbox" checked={confirmedNoKnownDuplicate} onChange={(event) => setConfirmedNoKnownDuplicate(event.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-border text-brand-accent" />I reviewed the available evidence and found no known duplicate.</label><div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void saveFinanceException()} disabled={saving || !canUseFinanceException || !confirmedProviderTransaction || !confirmedNoKnownDuplicate || reason.trim().length < 3}>{saving ? "Saving…" : "Include in PLAYBOOK Finance"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">Requires the reason above and both confirmations. Stripe is never changed.</p></div></>}</div>
          </details>}
        </div>
        {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
      </section>
    </div>}
  </>;
}
