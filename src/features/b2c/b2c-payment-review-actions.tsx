"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";

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

  async function resolveFlag(flagId: string) {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/review-flags/${flagId}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionStatus: "resolved", resolutionNote: reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The B2C review item could not be resolved.");
      setOpen(false); router.refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The B2C review item could not be resolved."); } finally { setSaving(false); }
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

  return <>
    <button type="button" onClick={openReview} className="font-medium text-brand-accent hover:underline">Edit locally</button>
    {open && <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-primary/30 p-4 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={`b2c-review-${row.id}`} className="mx-auto my-4 w-full max-w-4xl overflow-hidden rounded-card bg-surface p-5 shadow-elevated sm:my-8 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0"><h2 id={`b2c-review-${row.id}`} className="text-xl font-semibold text-text-primary sm:text-2xl">Edit B2C payment locally</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-text-muted">Every saved change is a separate PLAYBOOK correction with your reason and audit history. Stripe is never changed.</p></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close B2C payment editor" className="shrink-0 rounded-pill px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted hover:text-text-primary">Close</button>
        </div>

        <div className="mt-6 grid gap-x-6 gap-y-4 rounded-input border border-border bg-surface-muted/40 p-4 text-sm sm:grid-cols-2">
          <p className="min-w-0"><span className="text-text-muted">Stripe payment ID</span><span className="mt-1 block break-all font-mono text-xs text-text-primary">{row.providerReference ?? "Unavailable"}</span></p>
          <p className="min-w-0"><span className="text-text-muted">Stripe source product</span><span className="mt-1 block break-words font-medium text-text-primary">{row.productReference ?? "Unavailable from Stripe"}</span></p>
          <p><span className="text-text-muted">Provider payment status</span><span className="mt-1 block"><StatusBadge status={row.paymentStatus} /></span></p>
          <p><span className="text-text-muted">Provider source</span><span className="mt-1 block font-medium text-text-primary">{row.source}</span></p>
        </div>

        {hasUnmappedProduct && <div className="mt-5 overflow-hidden rounded-input border border-warning/25 bg-warning/5 p-4 sm:p-5">
          <h3 className="font-semibold text-text-primary">Create local product mapping</h3>
          <p className="mt-1 text-sm leading-6 text-text-secondary">A mapping classifies every local Stripe payment with the exact same product reference. It never edits Stripe. A one-payment correction below affects only this row.</p>
          {mappingAvailable ? <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <label className={fieldClass}>Internal product code<input className={inputClass} value={internalProductCode} onChange={(event) => setInternalProductCode(event.target.value)} placeholder="membership_annual" /></label>
            <label className={fieldClass}>Internal product name<input className={inputClass} value={internalProductName} onChange={(event) => setInternalProductName(event.target.value)} placeholder="Annual membership" /></label>
            <label className={fieldClass}>PLAYBOOK reporting category<input className={inputClass} value={mappingCategoryCode} onChange={(event) => setMappingCategoryCode(event.target.value)} placeholder="membership" /></label>
            <label className={fieldClass}>Membership tier <span className="font-normal text-text-muted">(optional)</span><input className={inputClass} value={mappingMembershipTier} onChange={(event) => setMappingMembershipTier(event.target.value)} placeholder="annual" /></label>
          </div> : <p className="mt-3 break-words text-sm leading-6 text-warning">Stripe did not provide a reusable product reference for this payment. You can still correct this one PLAYBOOK row below, but that will not affect any other payment.</p>}
        </div>}

        <div className="mt-5 overflow-hidden rounded-input border border-border bg-surface-muted/40 p-4 sm:p-5">
          <h3 className="font-semibold text-text-primary">Verified local values</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-text-secondary">Edit only values Finance has verified. Amount and business date affect PLAYBOOK reporting; the original Stripe amount and timestamp remain preserved for traceability. A failed provider payment always remains failed.</p>
          <div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">
            <label className={fieldClass}>Customer name<input className={inputClass} value={draft.customerName} onChange={(event) => updateDraft("customerName", event.target.value)} placeholder="Verified customer name" /></label>
            <label className={fieldClass}>Customer email<input className={inputClass} value={draft.customerEmail} onChange={(event) => updateDraft("customerEmail", event.target.value)} inputMode="email" placeholder="verified@example.com" /></label>
            <label className={fieldClass}>Customer mobile<input className={inputClass} value={draft.customerPhone} onChange={(event) => updateDraft("customerPhone", event.target.value)} inputMode="tel" placeholder="+973 0000 0000" /></label>
            <label className={fieldClass}>PLAYBOOK reporting category<input className={inputClass} value={draft.categoryCode} onChange={(event) => updateDraft("categoryCode", event.target.value)} placeholder="membership" /></label>
            <label className={fieldClass}>Plan / tier<input className={inputClass} value={draft.membershipTier} onChange={(event) => updateDraft("membershipTier", event.target.value)} placeholder="Founding Membership" /></label>
            <label className={fieldClass}>Local B2C amount (USD)<input className={inputClass} type="number" min="0.000001" step="0.000001" value={draft.amountUsd} onChange={(event) => updateDraft("amountUsd", event.target.value)} /><span className="mt-1 block text-xs font-normal text-text-muted">Stripe source amount: {row.sourceAmountUsd}</span></label>
            <label className={fieldClass}>Local business date<input className={inputClass} type="date" value={draft.occurredOn} onChange={(event) => updateDraft("occurredOn", event.target.value)} /><span className="mt-1 block text-xs font-normal text-text-muted">Stripe source date: {row.sourceDateValue}</span></label>
          </div>
        </div>

        <label className={`${fieldClass} mt-5`}>Reason / evidence<textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required: explain the verified evidence for this local change. This is saved in the audit history." /></label>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <PrimaryButton onClick={() => void saveLocalCorrection()} disabled={saving || !hasLocalCorrectionInput || reason.trim().length < 3}>{saving ? "Saving…" : "Save audited local correction"}</PrimaryButton>
          {hasUnmappedProduct && mappingAvailable && <PrimaryButton onClick={() => void mapProduct()} disabled={saving || reason.trim().length < 3}>{saving ? "Saving…" : "Save local product mapping"}</PrimaryButton>}
          <p className="text-xs leading-5 text-text-muted">{hasLocalCorrectionInput ? "The saved correction updates PLAYBOOK reporting only." : "Change at least one local value and enter a reason to save."}</p>
        </div>

        {row.openReviewFlags.length > 0 && <div className="mt-6 border-t border-border pt-5">
          <div><h3 className="font-semibold text-text-primary">Open review items</h3><p className="mt-1 text-sm leading-6 text-text-muted">Resolving an item records your note and closes that task only. It does not change Stripe or make a failed payment successful.</p></div>
          <div className="mt-4 space-y-3">
            {row.openReviewFlags.map((flag) => <div key={flag.id} className="overflow-hidden rounded-input border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3"><StatusBadge status={flag.type} /><button type="button" onClick={() => void resolveFlag(flag.id)} disabled={saving || reason.trim().length < 3} className="w-full shrink-0 rounded-pill border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:border-brand-accent hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto">Mark resolved</button></div>
              <p className="mt-3 break-words text-sm leading-6 text-text-secondary">{flag.reason}</p>
            </div>)}
          </div>
        </div>}
        {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
      </section>
    </div>}
  </>;
}
