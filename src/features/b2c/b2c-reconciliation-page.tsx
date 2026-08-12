"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorState, LoadingSkeleton, MetricCard, SectionCard, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cReconciliationSafeSummary } from "@/server/repositories/b2c-finance-reconciliation-repository";
import type { PaymentTrackerPreview } from "@/server/services/payment-tracker-upload";
import type { TapStatementPreview } from "@/server/services/tap-statement-upload";
import type { StripeChargesPreview } from "@/server/services/stripe-charges-upload";
import type { AdminStripeEvidenceRecord } from "@/server/services/stripe-charges-evidence";
import { B2cExactDuplicateReview } from "@/features/b2c/b2c-exact-duplicate-review";

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
  const [tapFile, setTapFile] = useState<File | null>(null);
  const [tapPreview, setTapPreview] = useState<TapStatementPreview | null>(null);
  const [tapUploadError, setTapUploadError] = useState<string | null>(null);
  const [tapUploading, setTapUploading] = useState(false);
  const [stripeFile, setStripeFile] = useState<File | null>(null); const [stripePreview, setStripePreview] = useState<StripeChargesPreview | null>(null); const [stripeError, setStripeError] = useState<string | null>(null); const [stripeUploading, setStripeUploading] = useState(false); const [stripeRecords, setStripeRecords] = useState<AdminStripeEvidenceRecord[]>([]);
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
  const loadStripeRecords = useCallback(async () => { if (!canManage) return; try { const response = await fetch("/api/admin/b2c/stripe-charges?limit=50", { cache: "no-store" }); const payload: unknown = await response.json().catch(() => null); if (response.ok && payload && typeof payload === "object" && "records" in payload && Array.isArray(payload.records)) setStripeRecords(payload.records as AdminStripeEvidenceRecord[]); } catch { setStripeRecords([]); } }, [canManage]);
  const stripeCompleted = summary?.sources.some((source) => source.key === "stripe_charges" && source.status === "completed") ?? false;
  useEffect(() => { if (stripeCompleted) void loadStripeRecords(); else setStripeRecords([]); }, [loadStripeRecords, stripeCompleted]);

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
  const requestTapPreview = async () => {
    if (!tapFile) return;
    setTapUploading(true); setTapUploadError(null); setTapPreview(null);
    try {
      const form = new FormData(); form.set("file", tapFile);
      const response = await fetch("/api/admin/b2c/tap-statement/preview", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("preview" in payload)) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The Tap statement preview could not be prepared.");
      setTapPreview(payload.preview as TapStatementPreview);
    } catch (error) { setTapUploadError(error instanceof Error ? error.message : "The Tap statement preview could not be prepared."); }
    finally { setTapUploading(false); }
  };
  const confirmTapImport = async () => {
    if (!tapFile || !tapPreview) return;
    setTapUploading(true); setTapUploadError(null);
    try {
      const form = new FormData(); form.set("file", tapFile); form.set("expectedFileSha256", tapPreview.sourceFileSha256);
      const response = await fetch("/api/admin/b2c/tap-statement/finalize", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The Tap statement could not be staged.");
      setTapFile(null); setTapPreview(null); await loadSummary();
    } catch (error) { setTapUploadError(error instanceof Error ? error.message : "The Tap statement could not be staged."); }
    finally { setTapUploading(false); }
  };
  const requestStripePreview = async () => { if (!stripeFile) return; setStripeUploading(true); setStripeError(null); setStripePreview(null); try { const form = new FormData(); form.set("file", stripeFile); const response = await fetch("/api/admin/b2c/stripe-charges/preview", { method: "POST", body: form }); const payload: unknown = await response.json().catch(() => null); if (!response.ok || !payload || typeof payload !== "object" || !("preview" in payload)) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The Stripe Charges preview could not be prepared."); setStripePreview(payload.preview as StripeChargesPreview); } catch (error) { setStripeError(error instanceof Error ? error.message : "The Stripe Charges preview could not be prepared."); } finally { setStripeUploading(false); } };
  const confirmStripeImport = async () => { if (!stripeFile || !stripePreview) return; setStripeUploading(true); setStripeError(null); try { const form = new FormData(); form.set("file", stripeFile); form.set("expectedFileSha256", stripePreview.sourceFileSha256); const response = await fetch("/api/admin/b2c/stripe-charges/finalize", { method: "POST", body: form }); const payload: unknown = await response.json().catch(() => null); if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The Stripe Charges file could not be staged."); setStripeFile(null); setStripePreview(null); await Promise.all([loadSummary(), loadStripeRecords()]); } catch (error) { setStripeError(error instanceof Error ? error.message : "The Stripe Charges file could not be staged."); } finally { setStripeUploading(false); } };

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
      {canManage && <SectionCard title="Tap statement upload" description="Preview one complete Tap .csv statement, then explicitly stage it as original-currency evidence. It never publishes B2C Finance revenue." className="mt-4">
        <label htmlFor="tap-statement-csv" className="text-sm font-medium text-text-primary">Tap statement CSV</label>
        <input id="tap-statement-csv" type="file" accept=".csv,text/csv" disabled={tapUploading} className="mt-2 block w-full text-sm" onChange={(event) => { setTapFile(event.target.files?.[0] ?? null); setTapPreview(null); setTapUploadError(null); }} />
        <div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!tapFile || tapUploading} onClick={() => void requestTapPreview()} className="rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{tapUploading ? "Processing…" : "Preview Tap statement"}</button><button type="button" disabled={!tapPreview || tapUploading} onClick={() => void confirmTapImport()} className="rounded-md border border-brand-primary px-4 py-2 text-sm font-semibold text-brand-primary disabled:cursor-not-allowed disabled:opacity-50">Confirm Tap staged import</button></div>
        {tapUploadError && <p className="mt-3 text-sm text-danger" role="alert">{tapUploadError}</p>}
        {tapPreview && <div className="mt-4 rounded-md border border-border bg-canvas p-4 text-sm text-text-secondary" role="status"><p className="font-medium text-text-primary">{tapPreview.totalRows} evidence rows</p><p className="mt-1">{tapPreview.kindCounts.sale} sales · {tapPreview.kindCounts.processing_fee} processing fees · {tapPreview.kindCounts.fee_vat} fee VAT · {tapPreview.kindCounts.refund} refunds · {tapPreview.kindCounts.transfer} transfers</p><p className="mt-1">{tapPreview.kindCounts.opening_balance} opening balances · {tapPreview.kindCounts.needs_review} need review · {tapPreview.missingPaymentIdSales} sales missing Tap payment IDs · {tapPreview.unparsedDates} raw dates retained</p><p className="mt-2 text-text-muted">Evidence only: original currency and raw statement dates are retained; no total, conversion, or revenue is created.</p></div>}
      </SectionCard>}
      {canManage && <SectionCard title="Stripe Charges upload" description="Preview a full Stripe Charges .csv, then explicitly stage private evidence. It never creates B2C Finance revenue." className="mt-4"><label htmlFor="stripe-charges-csv" className="text-sm font-medium text-text-primary">Stripe Charges CSV</label><input id="stripe-charges-csv" type="file" accept=".csv,text/csv" disabled={stripeUploading} className="mt-2 block w-full text-sm" onChange={(event) => { setStripeFile(event.target.files?.[0] ?? null); setStripePreview(null); setStripeError(null); }} /><div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!stripeFile || stripeUploading} onClick={() => void requestStripePreview()} className="rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{stripeUploading ? "Processing…" : "Preview Stripe Charges"}</button><button type="button" disabled={!stripePreview || stripeUploading} onClick={() => void confirmStripeImport()} className="rounded-md border border-brand-primary px-4 py-2 text-sm font-semibold text-brand-primary disabled:cursor-not-allowed disabled:opacity-50">Confirm Stripe staged import</button></div>{stripeError && <p className="mt-3 text-sm text-danger" role="alert">{stripeError}</p>}{stripePreview && <div className="mt-4 rounded-md border border-border bg-canvas p-4 text-sm text-text-secondary" role="status"><p className="font-medium text-text-primary">{stripePreview.sourceRows} source rows · {stripePreview.evidenceEntries} evidence entries</p><p className="mt-1">{stripePreview.saleEntries} sales · {stripePreview.refundEntries} refunds · {stripePreview.needsReviewEntries} need review · {stripePreview.rowsWithContact} with contact details</p><p className="mt-2 text-text-muted">Evidence only: no total, conversion, or revenue is created.</p></div>}</SectionCard>}
      {canManage && stripeRecords.length > 0 && <SectionCard title="Staged Stripe contact review" description="Admin-only source contacts for reconciliation. Sensitive payment details are never shown." className="mt-4"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-text-muted"><tr><th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Phone</th><th className="p-2">Entry</th><th className="p-2">Original evidence</th><th className="p-2">Charge ID</th></tr></thead><tbody>{stripeRecords.map((record) => <tr key={record.evidenceId} className="border-b border-border"><td className="p-2">{record.customerName ?? "—"}</td><td className="p-2">{record.customerEmail ?? "—"}</td><td className="p-2">{record.customerPhone ?? "—"}</td><td className="p-2">{record.transactionKind}</td><td className="p-2">{record.originalAmount ?? "—"} {record.originalCurrency}</td><td className="p-2">{record.chargeId ?? "—"}</td></tr>)}</tbody></table></div></SectionCard>}
      {canManage && summary.sources.some((source) => source.key === "payment_tracker" && source.status === "completed") && <B2cExactDuplicateReview onGroupsChanged={loadSummary} />}
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
