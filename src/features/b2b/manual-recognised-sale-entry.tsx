"use client";

import { FormEvent, useState } from "react";
import { X } from "lucide-react";
import { PrimaryButton } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import { calculateUsdAmount } from "@/lib/financial/usd-calculation";
import { firstValidationMessage, manualRecognisedSaleSchema } from "@/lib/validation/financial-contracts";
import type { B2bDashboardDeal } from "@/server/repositories/b2b-dashboard-repository";
import { useRouter } from "next/navigation";

const inputClass = "mt-1 block w-full min-w-0 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";
const selectableCurrencies = ["USD", "BHD"];

type RecognisedSaleForm = {
  recognisedAmount: string;
  originalCurrency: string;
  exchangeRateToUsd: string;
  recognitionDate: string;
  reportingMonth: string;
  reasonOrReference: string;
};

function formFor(deal: B2bDashboardDeal, reportingPeriod: string): RecognisedSaleForm {
  return {
    recognisedAmount: "",
    originalCurrency: deal.originalCurrency ?? "USD",
    // Supabase numeric values can arrive as numbers at runtime; form fields must always hold strings.
    exchangeRateToUsd: String(deal.exchangeRateToUsd ?? "1"),
    recognitionDate: reportingPeriod,
    reportingMonth: reportingPeriod.slice(0, 7),
    reasonOrReference: "",
  };
}

/** Admin-only recognised-sales entry. It records a local Finance decision, never a HubSpot write. */
export function ManualRecognisedSaleEntry({ deal, reportingPeriod }: { deal: B2bDashboardDeal; reportingPeriod: string }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RecognisedSaleForm>(() => formFor(deal, reportingPeriod));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!canManage) return null;

  function update(field: keyof RecognisedSaleForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateCurrency(value: string) {
    setForm((current) => ({
      ...current,
      originalCurrency: value,
      exchangeRateToUsd: value === "USD" ? "1" : current.originalCurrency === "USD" ? "" : current.exchangeRateToUsd,
    }));
  }

  function close() {
    if (!saving) {
      setOpen(false);
      setMessage(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recognisedAmountUsd = calculateUsdAmount(form.recognisedAmount, form.exchangeRateToUsd);
    const parsed = manualRecognisedSaleSchema.safeParse({
      dealId: deal.id,
      bookingId: deal.bookingId ?? undefined,
      recognisedAmount: form.recognisedAmount.trim(),
      originalCurrency: form.originalCurrency.trim().toUpperCase(),
      exchangeRateToUsd: form.exchangeRateToUsd.trim(),
      recognitionDate: form.recognitionDate,
      reportingPeriod: `${form.reportingMonth}-01`,
      reasonOrReference: form.reasonOrReference.trim(),
    });

    if (!parsed.success) {
      setMessage(firstValidationMessage(parsed.error));
      return;
    }

    if (recognisedAmountUsd === null) {
      setMessage("USD amount: enter a recognised amount and exchange rate with valid decimal places.");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/b2b/recognised-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The recognised-sales entry could not be saved.");
      setForm(formFor(deal, reportingPeriod));
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The recognised-sales entry could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button type="button" onClick={() => { setForm(formFor(deal, reportingPeriod)); setMessage(null); setOpen(true); }} className="text-left text-sm font-medium text-brand-accent hover:underline">Record recognised sale</button>
    {open && <RecognisedSaleDialog deal={deal} form={form} saving={saving} message={message} onClose={close} onSave={save} onUpdate={update} onUpdateCurrency={updateCurrency} />}
  </>;
}

function RecognisedSaleDialog({ deal, form, saving, message, onClose, onSave, onUpdate, onUpdateCurrency }: { deal: B2bDashboardDeal; form: RecognisedSaleForm; saving: boolean; message: string | null; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onUpdate: (field: keyof RecognisedSaleForm, value: string) => void; onUpdateCurrency: (value: string) => void }) {
  const recognisedAmountUsd = calculateUsdAmount(form.recognisedAmount, form.exchangeRateToUsd);

  return <div className="fixed inset-0 z-50 overflow-y-auto whitespace-normal bg-brand-primary/30 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby={`recognised-sale-${deal.id}`} className="mx-auto my-8 w-full max-w-2xl overflow-hidden rounded-card bg-white p-6 shadow-elevated sm:p-8">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 id={`recognised-sale-${deal.id}`} className="text-xl font-semibold text-ink">Record B2B recognised sale</h2><p className="mt-1 text-sm leading-6 text-text-secondary">{deal.name} · {deal.bookingId ? "linked to its booking" : "linked directly to this deal"}</p></div><button type="button" aria-label="Close recognised-sales entry" onClick={onClose} disabled={saving} className="shrink-0 rounded-pill p-2 text-text-secondary hover:bg-surface-muted disabled:cursor-not-allowed"><X size={19} /></button></div>
        <form className="mt-5 min-w-0" onSubmit={onSave}>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <label className={fieldClass}>Recognised amount<input required value={form.recognisedAmount} onChange={(event) => onUpdate("recognisedAmount", event.target.value)} className={inputClass} inputMode="decimal" placeholder="0.00" /></label>
            <label className={fieldClass}>Original currency<select value={form.originalCurrency} onChange={(event) => onUpdateCurrency(event.target.value)} className={inputClass}>{!selectableCurrencies.includes(form.originalCurrency) && <option value={form.originalCurrency}>{form.originalCurrency}</option>}<option value="USD">USD</option><option value="BHD">BHD</option></select></label>
            <label className={fieldClass}>Exchange rate to USD<input required readOnly={form.originalCurrency === "USD"} value={form.exchangeRateToUsd} onChange={(event) => onUpdate("exchangeRateToUsd", event.target.value)} className={inputClass} inputMode="decimal" placeholder="1.0000000000" /></label>
            <label className={fieldClass}>USD amount<input readOnly value={recognisedAmountUsd ?? ""} className={`${inputClass} bg-surface-muted`} placeholder="Calculated automatically" aria-describedby="usd-amount-help" /></label>
            <label className={fieldClass}>Recognition date<input required type="date" value={form.recognitionDate} onChange={(event) => onUpdate("recognitionDate", event.target.value)} className={inputClass} /></label>
            <label className={fieldClass}>Reporting month<input required type="month" value={form.reportingMonth} onChange={(event) => onUpdate("reportingMonth", event.target.value)} className={inputClass} /></label>
            <label className={`${fieldClass} md:col-span-2`}>Reason or reference<input required value={form.reasonOrReference} onChange={(event) => onUpdate("reasonOrReference", event.target.value)} className={inputClass} maxLength={1000} placeholder="Finance approval, accounting reference, or recognition rationale" /></label>
          </div>
          <p id="usd-amount-help" className="mt-2 text-xs text-text-secondary">Calculated from recognised amount × exchange rate and stored in USD.</p>
          {message && <div role="alert" className="mt-3 w-full max-w-full overflow-hidden rounded-md bg-danger/5 px-3 py-2 text-sm leading-6 text-danger"><p className="m-0" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>{message}</p></div>}
          <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} disabled={saving} className="rounded-pill px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted disabled:cursor-not-allowed">Cancel</button><PrimaryButton type="submit" disabled={saving}>{saving ? "Saving recognised sale…" : "Save recognised sale"}</PrimaryButton></div>
        </form>
      </section>
    </div>;
}
