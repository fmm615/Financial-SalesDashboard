"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorState, LoadingSkeleton, MetricCard, SectionCard, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cReconciliationSafeSummary } from "@/server/repositories/b2c-finance-reconciliation-repository";
import type { PaymentTrackerPreview } from "@/server/services/payment-tracker-upload";

function displayCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function displaySourceStatus(status: B2cReconciliationSafeSummary["sources"][number]["status"]): string {
  return status === "not_loaded" ? "Not loaded" : status[0].toUpperCase() + status.slice(1);
}

/** Coverage-only Operations page. It never exposes source rows or claims a B2C revenue total. */
export function B2cReconciliationPage() {
  const canManage = useCanManage();
  const [summary, setSummary] = useState<B2cReconciliationSafeSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PaymentTrackerPreview | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const loadSummary = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch("/api/b2c/reconciliation", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("summary" in payload)) throw new Error("Summary unavailable");
      setSummary(payload.summary as B2cReconciliationSafeSummary);
    } catch {
      setSummary(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const requestPreview = async () => {
    if (!file) return;
    setUploading(true); setUploadError(null); setPreview(null);
    try {
      const form = new FormData(); form.set("file", file);
      const response = await fetch("/api/admin/b2c/payment-tracker/preview", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("preview" in payload)) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The workbook preview could not be prepared.");
      setPreview(payload.preview as PaymentTrackerPreview);
    } catch (error) { setUploadError(error instanceof Error ? error.message : "The workbook preview could not be prepared."); }
    finally { setUploading(false); }
  };
  const confirmImport = async () => {
    if (!file || !preview) return;
    setUploading(true); setUploadError(null);
    try {
      const form = new FormData(); form.set("file", file); form.set("expectedFileSha256", preview.sourceFileSha256);
      const response = await fetch("/api/admin/b2c/payment-tracker/finalize", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The workbook could not be staged.");
      setFile(null); setPreview(null); await loadSummary();
    } catch (error) { setUploadError(error instanceof Error ? error.message : "The workbook could not be staged."); }
    finally { setUploading(false); }
  };

  return <AppShell title="B2C reconciliation" description="A controlled intake view for Finance workbook and provider evidence. Until reconciliation and Finance approval are complete, B2C Finance revenue is intentionally not published.">
    {!summary && !loadError && <section className="rounded-card border border-border bg-surface p-5 shadow-card"><p className="mb-3 text-sm text-text-muted">Loading B2C reconciliation coverage</p><LoadingSkeleton rows={5} /></section>}
    {loadError && <ErrorState title="Unable to load B2C reconciliation coverage" description="No import state or financial value has been changed. Please try again after confirming the required migrations are applied." />}
    {summary && <>
      <section className="rounded-card border border-warning/30 bg-warning/5 p-5" role="status">
        <StatusBadge status="Not fully loaded" />
        <h2 className="mt-3 text-lg font-semibold tracking-[-0.02em] text-text-primary">B2C Finance revenue is not published</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-secondary">{summary.publicationMessage}</p>
      </section>
      {canManage && <SectionCard title="Payment Tracker upload" description="Preview one Finance .xlsx file, then explicitly stage it. This does not publish B2C Finance revenue." className="mt-4">
        <label htmlFor="payment-tracker-workbook" className="text-sm font-medium text-text-primary">Payment Tracker workbook</label>
        <input id="payment-tracker-workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={uploading} className="mt-2 block w-full text-sm" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setUploadError(null); }} />
        <div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!file || uploading} onClick={() => void requestPreview()} className="rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{uploading ? "Processing…" : "Preview workbook"}</button><button type="button" disabled={!preview || uploading} onClick={() => void confirmImport()} className="rounded-md border border-brand-primary px-4 py-2 text-sm font-semibold text-brand-primary disabled:cursor-not-allowed disabled:opacity-50">Confirm staged import</button></div>
        {uploadError && <p className="mt-3 text-sm text-danger" role="alert">{uploadError}</p>}
        {preview && <div className="mt-4 rounded-md border border-border bg-canvas p-4 text-sm text-text-secondary" role="status"><p className="font-medium text-text-primary">{preview.summary.totalRows} extracted rows</p><p className="mt-1">Tabs: {preview.acceptedTabs.join(" and ")} · {preview.summary.validRows} valid · {preview.summary.needsReviewRows} need review · {preview.summary.zeroValueRows} zero-value · {preview.summary.invalidRows} invalid</p><p className="mt-1">Duplicate candidates: {preview.duplicateCandidates.exact} exact, {preview.duplicateCandidates.possible} possible, {preview.duplicateCandidates.conflicts} conflicts.</p><p className="mt-2 text-text-muted">Review only: staging retains source evidence and does not create a reportable total.</p></div>}
      </SectionCard>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Staged Finance rows" value={displayCount(summary.counts.stagedRows)} note="Retained for reconciliation; not a revenue total" />
        <MetricCard label="Needs Finance review" value={displayCount(summary.counts.needsReviewRows)} note="Missing, conflicting, or ambiguous source values" tone={summary.counts.needsReviewRows > 0 ? "warning" : "neutral"} />
        <MetricCard label="Zero-value rows" value={displayCount(summary.counts.zeroValueRows)} note="Kept as source history; excluded from revenue candidates" tone="warning" />
        <MetricCard label="Unresolved groups" value={displayCount(summary.counts.unresolvedGroups)} note="Groups awaiting an explicit Finance decision" tone={summary.counts.unresolvedGroups > 0 ? "warning" : "neutral"} />
      </div>
      <SectionCard title="Required source coverage" description="Every source must be complete and Finance-approved before a B2C Finance revenue period can be published." className="mt-4">
        <ul className="divide-y divide-border" aria-label="B2C source coverage">
          {summary.sources.map((source) => <li key={source.key} className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-text-primary">{source.label}</p><p className="mt-1 text-sm text-text-muted">{source.key === "payment_tracker" ? "Finance revenue candidates, excluding customer VAT" : source.key === "tap_statement" ? "Payment and settlement evidence only; retained in original currency" : "Required payment evidence and fee context; not yet supplied"}</p></div><StatusBadge status={displaySourceStatus(source.status)} /></li>)}
        </ul>
      </SectionCard>
      <SectionCard title="How this operates" description="The dashboard keeps evidence and revenue separate so no source is counted twice.">
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-text-secondary"><li>Finance rows are staged with their original tab, row number, and file hash.</li><li>Duplicate candidates and date conflicts remain unresolved until Finance records a reasoned decision.</li><li>Tap and Stripe records support reconciliation but never create another Finance revenue row.</li><li>Only a later Finance approval step can publish a verified B2C period.</li></ol>
      </SectionCard>
    </>}
  </AppShell>;
}
