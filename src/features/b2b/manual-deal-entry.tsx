"use client";

import { FormField } from "@/components/admin-ui";
import { PrimaryButton } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

const inputClass = "mt-2 block w-full min-w-0 rounded-card border border-border bg-surface px-3 py-2 font-normal text-text-primary";

type ManualDealForm = {
  companyName: string;
  name: string;
  ownerName: string;
  stageCode: string;
  pipelineOriginalAmount: string;
  originalCurrency: string;
  exchangeRateToUsd: string;
  closeDate: string;
  renewalDate: string;
  manualEntryReason: string;
};

const emptyForm: ManualDealForm = {
  companyName: "", name: "", ownerName: "", stageCode: "discovery",
  pipelineOriginalAmount: "", originalCurrency: "USD", exchangeRateToUsd: "1",
  closeDate: "", renewalDate: "", manualEntryReason: "",
};

/** Admin-only local Finance entry. It deliberately has no payment or revenue fields. */
export function ManualDealEntry() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ManualDealForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const canManage = useCanManage();

  if (!canManage) return null;

  function update(field: keyof ManualDealForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function close() {
    if (saving) return;
    setOpen(false);
    setMessage(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/b2b/deals/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          originalCurrency: form.originalCurrency.trim().toUpperCase(),
          ownerName: form.ownerName.trim() || null,
          closeDate: form.closeDate || null,
          renewalDate: form.renewalDate || null,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The manual B2B deal could not be saved.");
      setForm(emptyForm);
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The manual B2B deal could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <PrimaryButton onClick={() => setOpen(true)}><Plus size={16} />Add manual B2B deal</PrimaryButton>
    {open && <div className="fixed inset-0 z-40 overflow-y-auto bg-brand-primary/30 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="manual-deal-title" className="mx-auto my-8 w-full max-w-3xl rounded-panel bg-surface p-6 shadow-elevated sm:p-8">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 id="manual-deal-title" className="text-xl font-semibold tracking-[-0.03em] text-text-primary">Manual B2B deal entry</h2><p className="mt-1 text-sm leading-6 text-text-muted">For a Finance-approved B2B deal entered locally when HubSpot cannot be used.</p></div><button type="button" aria-label="Close manual B2B deal entry" onClick={close} disabled={saving} className="shrink-0 rounded-pill p-2 text-text-secondary hover:bg-surface-muted disabled:cursor-not-allowed"><X size={19} /></button></div>
        <p className="mt-4 rounded-card border border-warning/20 bg-warning/5 p-3 text-sm text-warning">This creates a local Finance record only. Saving is Admin-only, server-validated, duplicate-checked, and audited. HubSpot is never changed.</p>
        <form className="mt-5" onSubmit={save}>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <FormField label="Company"><input required value={form.companyName} onChange={(event) => update("companyName", event.target.value)} className={inputClass} maxLength={250} placeholder="Company legal name" /></FormField>
            <FormField label="Deal name"><input required value={form.name} onChange={(event) => update("name", event.target.value)} className={inputClass} maxLength={255} placeholder="Corporate programme or partnership" /></FormField>
            <FormField label="Owner"><input value={form.ownerName} onChange={(event) => update("ownerName", event.target.value)} className={inputClass} maxLength={200} placeholder="Deal owner" /></FormField>
            <FormField label="Pipeline stage"><select value={form.stageCode} onChange={(event) => update("stageCode", event.target.value)} className={inputClass}><option value="discovery">Discovery</option><option value="qualified">Qualified</option><option value="proposal">Proposal</option><option value="negotiation">Negotiation</option><option value="closed_won">Closed won</option><option value="closed_lost">Closed lost</option></select></FormField>
            <FormField label="Original amount"><input required value={form.pipelineOriginalAmount} onChange={(event) => update("pipelineOriginalAmount", event.target.value)} className={inputClass} inputMode="decimal" placeholder="0.00" /></FormField>
            <FormField label="Original currency"><input required value={form.originalCurrency} onChange={(event) => update("originalCurrency", event.target.value)} className={inputClass} maxLength={3} placeholder="USD" /></FormField>
            <FormField label="Exchange rate to USD"><input required value={form.exchangeRateToUsd} onChange={(event) => update("exchangeRateToUsd", event.target.value)} className={inputClass} inputMode="decimal" placeholder="1.0000000000" /></FormField>
            <FormField label="Close date"><input required={form.stageCode === "closed_won"} value={form.closeDate} onChange={(event) => update("closeDate", event.target.value)} className={inputClass} type="date" /></FormField>
            <FormField label="Renewal date"><input value={form.renewalDate} onChange={(event) => update("renewalDate", event.target.value)} className={inputClass} type="date" /></FormField>
            <FormField label="Entry reason"><input required value={form.manualEntryReason} onChange={(event) => update("manualEntryReason", event.target.value)} className={inputClass} maxLength={1000} placeholder="Required Finance-approved source or reason" /></FormField>
          </div>
          <p className="mt-4 text-xs leading-5 text-text-muted">A closed-won deal with a close date creates a separate booking. Cash received requires an invoice and receipt, and recognised sales is recorded separately with its own amount, reporting period, and reason.</p>
          {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
          <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={close} disabled={saving} className="rounded-pill px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted disabled:cursor-not-allowed">Cancel</button><PrimaryButton type="submit" disabled={saving}>{saving ? "Saving manual deal…" : "Save manual deal"}</PrimaryButton></div>
        </form>
      </section>
    </div>}
  </>;
}
