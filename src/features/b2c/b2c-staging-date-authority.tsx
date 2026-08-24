"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cStagingDateAuthorityRecord } from "@/server/repositories/b2c-workspace-repository";

function hasMeaningfulReason(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && !/^(?:-+|—+|n\/?a)$/i.test(trimmed);
}

function declaredValue(value: string | null): string {
  return value?.trim() || "Not provided";
}

function readableDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function dayMonthYear(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Confirms the already-parsed Date for exactly one immutable Payment Tracker
 * staging row. The browser submits no replacement date: the protected RPC
 * retains the original workbook facts and records only Finance's authority
 * decision with its audit reason.
 */
export function B2cStagingDateAuthority({ row, onSaved }: {
  row: B2cStagingDateAuthorityRecord;
  onSaved: (financeRowId: string) => void;
}) {
  const canManage = useCanManage();
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"confirm" | "correct">("confirm");
  const [correctedDate, setCorrectedDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canSubmit = canManage && hasMeaningfulReason(reason) && !saving;
  const parsedDate = readableDate(row.occurredOn);

  async function submit() {
    if (!canSubmit) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/b2c/finance-actions/date-authority", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financeRowIds: [row.financeRowId], reason: reason.trim() }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "The B2C Finance Date decision could not be saved.");
      onSaved(row.financeRowId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The B2C Finance Date decision could not be saved. No source data was changed.");
    } finally {
      setSaving(false);
    }
  }

  async function saveCorrection() {
    if (!canSubmit || !correctedDate) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/b2c/finance-actions/${row.financeRowId}/correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurredOn: correctedDate, reason: reason.trim() }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "The B2C Finance date correction could not be saved.");
      onSaved(row.financeRowId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The B2C Finance date correction could not be saved. No source data was changed.");
    } finally { setSaving(false); }
  }

  return <div>
    <p className="text-sm leading-6 text-text-secondary">The workbook&rsquo;s Date value says {parsedDate}. The Month label says {declaredValue(row.declaredMonth)}. Confirm the Date only when it is the authoritative financial date.</p>
    <dl className="mt-4 grid gap-3 rounded-input border border-border bg-surface-muted/35 p-4 text-sm sm:grid-cols-2">
      <div><dt className="text-text-muted">Source row</dt><dd className="mt-1 font-medium text-text-primary">{row.sourceTab} row {row.sourceRowNumber}</dd></div>
      <div><dt className="text-text-muted">Workbook Date</dt><dd className="mt-1 font-medium text-text-primary">{parsedDate}</dd><dd className="mt-1 text-text-secondary">DD/MM/YYYY: {dayMonthYear(row.occurredOn)}</dd><dd className="mt-1 text-xs text-text-muted">Stored value: {row.occurredOn}</dd></div>
      <div><dt className="text-text-muted">Declared Month</dt><dd className="mt-1 text-text-secondary">{declaredValue(row.declaredMonth)}</dd></div>
      <div><dt className="text-text-muted">Declared Year</dt><dd className="mt-1 text-text-secondary">{declaredValue(row.declaredYear)}</dd></div>
    </dl>
    {!canManage ? <p className="mt-4 text-sm leading-6 text-text-muted">Viewer access is read-only. Only an Admin can take this action.</p> : <>
      <div className="mt-4 flex flex-wrap gap-2"><PrimaryButton onClick={() => setMode("confirm")} disabled={saving}>Confirm workbook Date</PrimaryButton><button type="button" onClick={() => setMode("correct")} disabled={saving} className="min-h-10 rounded-pill border border-border px-4 py-2 text-sm font-semibold text-text-primary disabled:opacity-60">Correct financial date</button></div>
      {mode === "correct" && <label className="mt-4 block text-sm font-medium text-text-secondary">Correct financial date (DD/MM/YYYY)<input type="date" value={correctedDate} onChange={(event) => setCorrectedDate(event.target.value)} className="mt-1 block w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent" /></label>}
      <label className="mt-4 block text-sm font-medium text-text-secondary">Reason / evidence <span className="font-normal text-text-muted">(required)</span><textarea className="mt-1 block min-h-24 w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={mode === "correct" ? "Explain the evidence for the corrected financial date. This is saved in the audit history." : "Explain why the readable workbook Date is authoritative. This is saved in the audit history."} /></label>
      <div className="mt-4 flex flex-wrap items-center gap-3"><PrimaryButton onClick={() => void (mode === "correct" ? saveCorrection() : submit())} disabled={!canSubmit || (mode === "correct" && !correctedDate)}>{saving ? "Saving…" : mode === "correct" ? "Save corrected financial date" : "Confirm parsed Date"}</PrimaryButton><p className="text-xs leading-5 text-text-muted">This records one audited decision and never edits the uploaded workbook.</p></div>
    </>}
    {message && <p role="alert" className="mt-3 text-sm text-danger">{message}</p>}
  </div>;
}
