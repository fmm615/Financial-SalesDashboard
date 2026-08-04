"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton } from "@/components/ui";
import { ManualRecognisedSaleEntry } from "@/features/b2b/manual-recognised-sale-entry";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2bDashboardDeal } from "@/server/repositories/b2b-dashboard-repository";

const inputClass = "mt-1 block w-full min-w-0 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";

function nullable(value: string): string | null { return value.trim() || null; }

/** Admin-only local override/exclusion controls. These never call HubSpot. */
export function B2bDealAdminActions({ deal, reportingPeriod }: { deal: B2bDashboardDeal; reportingPeriod: string }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(deal.name);
  const [ownerName, setOwnerName] = useState(deal.owner ?? "");
  const [stageCode, setStageCode] = useState(deal.stage);
  const [amount, setAmount] = useState(deal.originalAmount ?? "");
  const [currency, setCurrency] = useState(deal.originalCurrency ?? "");
  const [exchangeRateToUsd, setExchangeRateToUsd] = useState(deal.exchangeRateToUsd ?? "");
  const [closeDate, setCloseDate] = useState(deal.closeDate ?? "");
  const [renewalDate, setRenewalDate] = useState(deal.renewalDate ?? "");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canManage) return null;

  async function submit(path: "override" | "exclude") {
    setSaving(true); setMessage(null);
    try {
      const body = path === "exclude" ? { reason } : { name, ownerName: nullable(ownerName), stageCode, amount: nullable(amount), currency: nullable(currency)?.toUpperCase() ?? null, exchangeRateToUsd: nullable(exchangeRateToUsd), closeDate: nullable(closeDate), renewalDate: nullable(renewalDate), reason };
      const response = await fetch(`/api/admin/hubspot/deals/${deal.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The local change could not be saved.");
      setOpen(false); router.refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The local change could not be saved."); } finally { setSaving(false); }
  }

  return <div className="flex flex-col items-start gap-2">
    <button type="button" onClick={() => setOpen(true)} className="font-medium text-brand-accent hover:underline">Review / edit</button>
    {!deal.issue && <ManualRecognisedSaleEntry deal={deal} reportingPeriod={reportingPeriod} />}
    {open && <div className="fixed inset-0 z-50 overflow-y-auto whitespace-normal bg-brand-primary/30 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby={`deal-${deal.id}`} className="mx-auto my-8 w-full max-w-3xl rounded-card bg-white p-6 shadow-elevated sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0"><h2 id={`deal-${deal.id}`} className="text-xl font-semibold text-ink">Review HubSpot deal</h2><p className="mt-1 text-sm text-slate-600">Changes are local to PLAYBOOK, require a reason, and are fully audited. HubSpot is never changed.</p></div>
          <button type="button" onClick={() => setOpen(false)} className="shrink-0 text-sm text-slate-600">Close</button>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
          <label className={fieldClass}>Deal name<input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className={fieldClass}>Owner<input className={inputClass} value={ownerName} onChange={(event) => setOwnerName(event.target.value)} /></label>
          <label className={fieldClass}>Stage<select className={inputClass} value={stageCode} onChange={(event) => setStageCode(event.target.value)}><option value="discovery">Discovery</option><option value="qualified">Qualified</option><option value="proposal">Proposal</option><option value="negotiation">Negotiation</option><option value="parked">Parked</option><option value="closed_won">Closed won</option><option value="closed_lost">Closed lost</option></select></label>
          <label className={fieldClass}>Amount<input className={inputClass} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="Unknown" /></label>
          <label className={fieldClass}>Original currency<input className={inputClass} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} placeholder="USD" /></label>
          <label className={fieldClass}>Exchange rate to USD<input className={inputClass} value={exchangeRateToUsd} onChange={(event) => setExchangeRateToUsd(event.target.value)} inputMode="decimal" placeholder="1" /></label>
          <label className={fieldClass}>Close date<input className={inputClass} type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} /></label>
          <label className={fieldClass}>Renewal date<input className={inputClass} type="date" value={renewalDate} onChange={(event) => setRenewalDate(event.target.value)} /></label>
          <label className={`${fieldClass} md:col-span-2`}>Reason / evidence<input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required audit reason" /></label>
        </div>
        <div className="mt-6 flex flex-wrap gap-3"><PrimaryButton onClick={() => void submit("override")} disabled={saving}>{saving ? "Saving…" : "Save audited local update"}</PrimaryButton><button type="button" onClick={() => void submit("exclude")} disabled={saving} className="rounded-pill border border-danger px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/5 disabled:opacity-60">Exclude locally</button></div>
        {message && <p role="alert" className="mt-3 text-sm text-red-700">{message}</p>}
        <p className="mt-3 text-xs text-slate-500">Excluding removes this deal from PLAYBOOK operational views and totals but retains the source record and audit history.</p>
      </section>
    </div>}
  </div>;
}
