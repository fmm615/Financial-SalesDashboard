"use client";

import { FormField } from "@/components/admin-ui";
import { ConfirmationDialog } from "@/components/admin-ui";
import { PrimaryButton } from "@/components/ui";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useCanManage } from "@/lib/auth/role-context";

const inputClass = "mt-2 block w-full min-w-0 rounded-card border border-border bg-surface px-3 py-2 font-normal text-text-primary";

export function ManualDealEntry() {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const canManage = useCanManage();

  if (!canManage) return null;

  return <>
    <PrimaryButton onClick={() => setOpen(true)}><Plus size={16} />Add manual B2B deal</PrimaryButton>
    {open && <div className="fixed inset-0 z-40 overflow-y-auto bg-brand-primary/30 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="manual-deal-title" className="mx-auto my-8 w-full max-w-3xl rounded-panel bg-surface p-6 shadow-elevated sm:p-8">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 id="manual-deal-title" className="text-xl font-semibold tracking-[-0.03em] text-text-primary">Manual B2B deal entry</h2><p className="mt-1 text-sm leading-6 text-text-muted">For a Finance-approved B2B deal entered locally when HubSpot cannot be used.</p></div><button type="button" aria-label="Close manual B2B deal entry" onClick={() => setOpen(false)} className="shrink-0 rounded-pill p-2 text-text-secondary hover:bg-surface-muted"><X size={19} /></button></div>
        <p className="mt-4 rounded-card border border-warning/20 bg-warning/5 p-3 text-sm text-warning">UI preview only. Future saving requires an Admin, server-side validation, duplicate protection, and an audit entry.</p>
        <div className="mt-5 grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
          <FormField label="Company"><input className={inputClass} placeholder="Company legal name" /></FormField>
          <FormField label="Deal name"><input className={inputClass} placeholder="Corporate programme or partnership" /></FormField>
          <FormField label="Owner"><input className={inputClass} placeholder="Deal owner" /></FormField>
          <FormField label="Pipeline stage"><select className={inputClass}><option>Discovery</option><option>Qualified</option><option>Proposal</option><option>Negotiation</option><option>Parked</option><option>Closed won</option><option>Closed lost</option></select></FormField>
          <FormField label="Original amount"><input className={inputClass} inputMode="decimal" placeholder="0.00" /></FormField>
          <FormField label="Original currency"><input className={inputClass} maxLength={3} placeholder="USD" /></FormField>
          <FormField label="Exchange rate to USD"><input className={inputClass} inputMode="decimal" placeholder="1.0000000000" /></FormField>
          <FormField label="Close date"><input className={inputClass} type="date" /></FormField>
          <FormField label="Renewal date"><input className={inputClass} type="date" /></FormField>
          <FormField label="Entry reason"><input className={inputClass} placeholder="Required Finance-approved source or reason" /></FormField>
        </div>
        <p className="mt-4 text-xs leading-5 text-text-muted">A closed-won deal with a close date creates a separate booking. Cash received requires an invoice and receipt, and recognised sales is recorded separately with its own amount, reporting period, and reason.</p>
        <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setOpen(false)} className="rounded-pill px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted">Cancel</button><PrimaryButton onClick={() => setConfirming(true)}>Review manual deal</PrimaryButton></div>
      </section>
    </div>}
    {confirming && <ConfirmationDialog title="Review manual B2B deal" description="This preview demonstrates the Finance-entry workflow. No deal will be saved until the secure backend, Admin authorization, duplicate protection, source traceability, and audit history are implemented." onClose={() => { setConfirming(false); setOpen(false); }} />}
  </>;
}
