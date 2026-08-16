"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PrimaryButton } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

const inputClass = "mt-1 block h-10 w-full min-w-0 rounded-input border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-brand-accent";
const textareaClass = "mt-1 block min-h-24 w-full min-w-0 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent";
const fieldClass = "block min-w-0 text-sm font-medium text-text-secondary";

function validReason(value: string): boolean {
  return value.trim().length >= 3 && !/^(?:-+|—+|n\/?a)$/i.test(value.trim());
}

/** A refund is immutable source activity; Finance can only add a local USD conversion. */
export function B2cRefundFxReviewActions({ row }: { row: B2cLedgerRow }) {
  const canManage = useCanManage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [exchangeRateToUsd, setExchangeRateToUsd] = useState("");
  const [conversionSource, setConversionSource] = useState("");
  const [effectiveOn, setEffectiveOn] = useState(row.sourceDateValue);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canManage || row.recordType !== "Refund" || !row.isForeignCurrency) return null;

  async function save() {
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/refunds/${row.id}/fx-conversion`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchangeRateToUsd, conversionSource, effectiveOn, reason }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Finance USD refund conversion could not be saved.");
      setOpen(false); router.refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "The Finance USD refund conversion could not be saved."); } finally { setSaving(false); }
  }

  return <>
    <button type="button" onClick={() => { setMessage(null); setOpen(true); }} className="font-medium text-brand-accent hover:underline">{row.foreignCurrencyReview ? "Set USD conversion" : "Review conversion"}</button>
    {open && <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-primary/30 p-4 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={`b2c-refund-fx-${row.id}`} className="mx-auto my-4 w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-card bg-surface p-5 shadow-elevated sm:my-8 sm:max-w-xl sm:p-8">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 id={`b2c-refund-fx-${row.id}`} className="text-xl font-semibold text-text-primary">Record refund USD conversion</h2><p className="mt-1 break-words text-sm leading-6 text-text-muted">The refund is retained as {row.sourceAmountUsd}. Save a Finance-approved local USD conversion only; {row.source} is never changed.</p></div><button type="button" onClick={() => setOpen(false)} className="shrink-0 rounded-pill px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-muted">Close</button></div>
        {row.hasFxConversion && <p className="mt-5 rounded-input border border-success/20 bg-success/5 p-3 text-sm text-success">Latest local conversion: <strong>{row.amountUsd}</strong>{row.fxConversionSource ? ` · ${row.fxConversionSource}` : ""}.</p>}
        <div className="mt-5 grid gap-4"><label className={fieldClass}>USD per 1 {row.sourceOriginalCurrency}<input className={inputClass} type="number" min="0.0000000001" step="0.0000000001" value={exchangeRateToUsd} onChange={(event) => setExchangeRateToUsd(event.target.value)} /></label><label className={fieldClass}>Finance conversion source<input className={inputClass} value={conversionSource} onChange={(event) => setConversionSource(event.target.value)} placeholder="Approved Finance FX rate / accounting evidence" /></label><label className={fieldClass}>Conversion effective date<input className={inputClass} type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} /></label><label className={fieldClass}>Reason / evidence<textarea className={textareaClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why Finance approved this conversion" /></label></div>
        {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void save()} disabled={saving || !exchangeRateToUsd.trim() || !conversionSource.trim() || !effectiveOn || !validReason(reason)}>{saving ? "Saving…" : row.hasFxConversion ? "Record revised conversion" : "Save Finance USD conversion"}</PrimaryButton><p className="text-xs text-text-muted">This is append-only and audited in PLAYBOOK.</p></div>
      </section>
    </div>}
  </>;
}
