"use client";

import { useState } from "react";
import { PrimaryButton, SectionCard } from "@/components/ui";
import type { B2cFinanceActionItem, B2cFinanceActionOverview } from "@/server/services/b2c-finance-action-center";

const rowId = (item: B2cFinanceActionItem) => item.id.split(":")[1] ?? "";

type CorrectionDraft = { occurredOn: string; amountUsd: string; customerName: string; category: string; reason: string };
const emptyDraft: CorrectionDraft = { occurredOn: "", amountUsd: "", customerName: "", category: "", reason: "" };

/** Handles the two remaining Finance data-quality paths: confirm a usable Date or save a verified overlay. */
export function B2cFinanceDataQualityActions({ overview, onChanged }: { overview: B2cFinanceActionOverview; onChanged(): void | Promise<void> }) {
  const [dateReason, setDateReason] = useState("");
  const [savingDates, setSavingDates] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, CorrectionDraft>>({});
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const dateItems = overview.items.filter((item) => item.actionType === "date_authority");
  const correctionItems = overview.items.filter((item) => item.actionType === "correction");

  const applyDates = async () => {
    setSavingDates(true); setError(null); setSuccess(null);
    try {
      const response = await fetch("/api/admin/b2c/finance-actions/date-authority", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financeRowIds: dateItems.map(rowId), reason: dateReason }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("resolvedRows" in payload) || typeof payload.resolvedRows !== "number") {
        throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Could not confirm the Finance dates.");
      }
      setSuccess(`${payload.resolvedRows} Date decision${payload.resolvedRows === 1 ? "" : "s"} recorded. The original Month and Year labels remain visible in history.`);
      setDateReason(""); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm the Finance dates. No source data was changed."); }
    finally { setSavingDates(false); }
  };

  const updateDraft = (id: string, field: keyof CorrectionDraft, value: string) => setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? emptyDraft), [field]: value } }));
  const saveCorrection = async (item: B2cFinanceActionItem) => {
    const id = rowId(item); const draft = drafts[id] ?? emptyDraft;
    setSavingRow(id); setError(null); setSuccess(null);
    try {
      const payload = {
        ...(draft.occurredOn ? { occurredOn: draft.occurredOn } : {}),
        ...(draft.amountUsd ? { amountUsd: draft.amountUsd } : {}),
        ...(draft.customerName ? { customerName: draft.customerName } : {}),
        ...(draft.category ? { category: draft.category } : {}),
        reason: draft.reason,
      };
      const response = await fetch(`/api/admin/b2c/finance-actions/${id}/correction`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "Could not save the Finance correction.");
      setSuccess(`B2C Finance row ${item.sourceRowNumber} was corrected. The original workbook value remains visible in history.`);
      setDrafts((current) => ({ ...current, [id]: emptyDraft })); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the Finance correction. No source data was changed."); }
    finally { setSavingRow(null); }
  };

  return <SectionCard title="Information to correct" description="Use the trusted Finance source. Corrections are saved as an auditable layer over the workbook; they do not overwrite it." className="mt-4">
    <div className="space-y-6">
      {dateItems.length > 0 && <div className="rounded-md border border-border bg-canvas p-4">
        <h3 className="font-medium text-text-primary">Valid Dates with the wrong Month or Year label</h3>
        <p className="mt-1 text-sm leading-6 text-text-muted">{dateItems.length} row{dateItems.length === 1 ? "" : "s"} have a readable Date, so Finance can confirm that Date without editing the original labels.</p>
        <label htmlFor="date-authority-reason" className="mt-3 block text-sm font-medium text-text-primary">Reason for using the Date</label>
        <textarea id="date-authority-reason" value={dateReason} onChange={(event) => setDateReason(event.target.value)} rows={2} maxLength={1000} className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent" />
        <div className="mt-3"><PrimaryButton disabled={dateReason.trim().length < 3 || savingDates} onClick={() => void applyDates()}>{savingDates ? "Recording…" : `Use the verified Date for ${dateItems.length} payment${dateItems.length === 1 ? "" : "s"}`}</PrimaryButton></div>
      </div>}
      {correctionItems.map((item) => {
        const id = rowId(item); const draft = drafts[id] ?? emptyDraft;
        const hasCorrection = Boolean(draft.occurredOn || draft.amountUsd || draft.customerName || draft.category);
        return <div key={item.id} className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-text-primary">{item.sourceTab} row {item.sourceRowNumber}</h3><span className="text-xs font-medium uppercase tracking-[0.08em] text-warning">Needs verification</span></div>
          <p className="mt-1 text-sm leading-6 text-text-muted">{item.explanation}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-text-primary">Verified Date<input type="date" value={draft.occurredOn} onChange={(event) => updateDraft(id, "occurredOn", event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-normal" /></label>
            <label className="text-sm font-medium text-text-primary">Verified amount (USD)<input inputMode="decimal" value={draft.amountUsd} onChange={(event) => updateDraft(id, "amountUsd", event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-normal" /></label>
            <label className="text-sm font-medium text-text-primary">Verified customer name<input value={draft.customerName} onChange={(event) => updateDraft(id, "customerName", event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-normal" /></label>
            <label className="text-sm font-medium text-text-primary">Verified category<input value={draft.category} onChange={(event) => updateDraft(id, "category", event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-normal" /></label>
          </div>
          <label className="mt-3 block text-sm font-medium text-text-primary">Reason for this correction<textarea value={draft.reason} onChange={(event) => updateDraft(id, "reason", event.target.value)} rows={2} maxLength={1000} className="mt-1 block w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-normal" /></label>
          <div className="mt-3"><PrimaryButton disabled={!hasCorrection || draft.reason.trim().length < 3 || savingRow !== null} onClick={() => void saveCorrection(item)}>{savingRow === id ? "Saving…" : `Save correction for row ${item.sourceRowNumber}`}</PrimaryButton></div>
        </div>;
      })}
      {dateItems.length === 0 && correctionItems.length === 0 && <p className="text-sm text-text-muted">No Finance information needs correction.</p>}
    </div>
    {success && <p className="mt-4 rounded-md border border-success/25 bg-success/5 p-3 text-sm text-success" role="status">{success}</p>}
    {error && <p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
  </SectionCard>;
}
