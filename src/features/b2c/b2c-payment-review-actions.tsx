"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";

/** Local Admin review controls for a Stripe source record. No action calls Stripe. */
export function B2cPaymentReviewActions({ row }: { row: B2cLedgerRow }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [internalProductCode, setInternalProductCode] = useState("");
  const [internalProductName, setInternalProductName] = useState("");
  const [categoryCode, setCategoryCode] = useState("");
  const [membershipTier, setMembershipTier] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mappingAvailable = row.sourceSystem === "stripe" && Boolean(row.productReference);
  if (!canManage || (row.openReviewFlags.length === 0 && !mappingAvailable)) return null;

  const hasUnmappedProduct = row.openReviewFlags.some((flag) => flag.type === "Unmapped product");

  async function mapProduct() {
    if (!row.productReference) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/b2c/stripe-products/map", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productReference: row.productReference, internalProductCode, internalProductName, categoryCode, membershipTier: membershipTier || undefined, reason }),
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

  return <>
    <button type="button" onClick={() => setOpen(true)} className="font-medium text-brand-accent hover:underline">{row.openReviewFlags.length ? "Review" : "Edit mapping"}</button>
    {open && <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-primary/30 p-4 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={`b2c-review-${row.id}`} className="mx-auto my-4 w-full max-w-4xl overflow-hidden rounded-card bg-surface p-5 shadow-elevated sm:my-8 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0"><h2 id={`b2c-review-${row.id}`} className="text-xl font-semibold text-text-primary sm:text-2xl">Review Stripe payment</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-text-muted">All changes are local to PLAYBOOK, require a reason, and are audited. Stripe is never changed.</p></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close Stripe payment review" className="shrink-0 rounded-pill px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted hover:text-text-primary">Close</button>
        </div>

        <div className="mt-6 grid gap-x-6 gap-y-4 rounded-input border border-border bg-surface-muted/40 p-4 text-sm sm:grid-cols-2">
          <p className="min-w-0"><span className="text-text-muted">Payment ID</span><span className="mt-1 block break-all font-mono text-xs text-text-primary">{row.providerReference ?? "Unavailable"}</span></p>
          <p className="min-w-0"><span className="text-text-muted">Source product</span><span className="mt-1 block break-words font-medium text-text-primary">{row.productReference ?? "Unavailable from Stripe"}</span></p>
          <p><span className="text-text-muted">Current category</span><span className="mt-1 block font-medium text-text-primary">{row.category}</span></p>
          <p><span className="text-text-muted">Current tier</span><span className="mt-1 block font-medium text-text-primary">{row.membershipTier ?? "Not set"}</span></p>
        </div>

        {row.sourceSystem === "stripe" && <div className="mt-5 overflow-hidden rounded-input border border-warning/25 bg-warning/5 p-4 sm:p-5">
          <h3 className="font-semibold text-text-primary">{hasUnmappedProduct ? "Create" : "Edit"} local product mapping</h3>
          <p className="mt-1 text-sm leading-6 text-text-secondary">This classifies every local Stripe payment with this exact source product reference. It never edits Stripe.</p>
          {mappingAvailable ? <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <label className={fieldClass}>Internal product code<input className={inputClass} value={internalProductCode} onChange={(event) => setInternalProductCode(event.target.value)} placeholder="membership_annual" /></label>
            <label className={fieldClass}>Internal product name<input className={inputClass} value={internalProductName} onChange={(event) => setInternalProductName(event.target.value)} placeholder="Annual membership" /></label>
            <label className={fieldClass}>Reporting category<input className={inputClass} value={categoryCode} onChange={(event) => setCategoryCode(event.target.value)} placeholder="membership" /></label>
            <label className={fieldClass}>Membership tier <span className="font-normal text-text-muted">(optional)</span><input className={inputClass} value={membershipTier} onChange={(event) => setMembershipTier(event.target.value)} placeholder="annual" /></label>
          </div> : <p className="mt-3 max-w-full whitespace-normal text-sm leading-6 text-warning" style={{ overflowWrap: "anywhere" }}>Stripe did not provide the configured product reference for this payment, so it cannot be mapped. You may resolve the review item with a note, but it remains excluded from financial totals.</p>}
        </div>}

        <label className={`${fieldClass} mt-5`}>Reason / evidence<textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence or resolution. This is saved in the audit history." /></label>
        {row.openReviewFlags.length > 0 && <div className="mt-6 border-t border-border pt-5">
          <div><h3 className="font-semibold text-text-primary">Open review items</h3><p className="mt-1 text-sm leading-6 text-text-muted">Use the same audit note above when resolving an item. Resolving does not change Stripe.</p></div>
          <div className="mt-4 space-y-3">
          {row.openReviewFlags.map((flag) => <div key={flag.id} className="overflow-hidden rounded-input border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusBadge status={flag.type} />
              <button type="button" onClick={() => void resolveFlag(flag.id)} disabled={saving || reason.trim().length < 3} className="w-full shrink-0 rounded-pill border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:border-brand-accent hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto">Mark resolved</button>
            </div>
            <p className="mt-3 max-w-full whitespace-normal text-sm leading-6 text-text-secondary" style={{ overflowWrap: "anywhere" }}>{flag.reason}</p>
          </div>)}
          </div>
        </div>}
        {mappingAvailable && <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5"><PrimaryButton onClick={() => void mapProduct()} disabled={saving || reason.trim().length < 3}>{saving ? "Saving…" : "Save audited local mapping"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">This updates PLAYBOOK classifications only. Stripe is never changed.</p></div>}
        {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
      </section>
    </div>}
  </>;
}
