"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, SectionCard, StatusBadge, TableCell, TableHead, TableHeader } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";

type ArchiveItem = {
  id: string;
  reportType: "monthly" | "quarterly" | "annual" | "ad_hoc";
  periodStart: string;
  periodEnd: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  requestedAt: string;
  safeErrorSummary: string | null;
  readinessStatus: "draft_fixture_only" | "financial_ready" | null;
  snapshotVersion: string | null;
  coverageSummary: string | null;
  hasPdf: boolean;
  hasCsv: boolean;
};

const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;
const typeLabels: Record<ArchiveItem["reportType"], string> = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual", ad_hoc: "Ad-hoc" };

export function ReportsPage() {
  const canManage = useCanManage();
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [periodStart, setPeriodStart] = useState(monthStart);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [reportType, setReportType] = useState<ArchiveItem["reportType"]>("ad_hoc");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function loadArchive() {
    setLoading(true);
    try {
      const response = await fetch("/api/reports", { cache: "no-store" });
      const body = await response.json().catch(() => null) as { reports?: ArchiveItem[]; error?: string } | null;
      if (response.ok && body?.reports) setItems(body.reports);
      else setMessage(body?.error ?? "The report archive could not be loaded.");
    } catch {
      setMessage("The report archive could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadArchive(); }, []);

  async function generate() {
    setSubmitting(true);
    setMessage(null);
    const queued = await fetch("/api/reports", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportType, periodStart, periodEnd, deliveryRequested: false }),
    });
    const queueBody = await queued.json().catch(() => null) as { jobId?: string; error?: string } | null;
    if (!queued.ok || !queueBody?.jobId) {
      setMessage(queueBody?.error ?? "The draft report could not be queued."); setSubmitting(false); return;
    }
    setMessage("Draft report queued. The protected worker can archive it without using B2C or B2B financial data once it is configured and run.");
    await loadArchive();
    setSubmitting(false);
  }

  async function retry(id: string) {
    setMessage(null);
    const response = await fetch(`/api/reports/${id}/retry`, { method: "POST" });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    setMessage(response.ok ? "Draft report requeued for the protected worker." : body?.error ?? "The draft report could not be requeued.");
    await loadArchive();
  }

  const visibleItems = useMemo(() => items.filter((item) => `${item.reportType} ${item.periodStart} ${item.periodEnd} ${item.status}`.toLowerCase().includes(search.toLowerCase())), [items, search]);

  return <AppShell title="Reports" description="Draft report archive and download workflow. Financial reporting remains disabled until B2C and B2B data is approved.">
    {canManage && <SectionCard title="Generate a draft report" description="This validates jobs, PDF/CSV archives, and downloads only. It deliberately contains no financial totals.">
      <div className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm font-medium text-text-secondary">Start date<input aria-label="Report start date" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-border bg-surface px-3 text-sm" /></label>
        <label className="text-sm font-medium text-text-secondary">End date<input aria-label="Report end date" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} className="mt-2 h-11 w-full rounded-md border border-border bg-surface px-3 text-sm" /></label>
        <label className="text-sm font-medium text-text-secondary">Report type<select aria-label="Report type" value={reportType} onChange={(event) => setReportType(event.target.value as ArchiveItem["reportType"])} className="mt-2 h-11 w-full rounded-md border border-border bg-surface px-3 text-sm"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="ad_hoc">Ad-hoc</option></select></label>
        <button type="button" onClick={() => void generate()} disabled={submitting} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-brand-primary px-4 text-sm font-semibold text-white disabled:opacity-60"><FileText size={16} />{submitting ? "Archiving…" : "Generate report"}</button>
      </div>
      <p className="mt-4 text-xs leading-5 text-text-muted">Email delivery and scheduled reports are intentionally disabled until real financial totals pass Finance review.</p>
    </SectionCard>}
    {message && <p role="status" className="mt-4 rounded-md border border-border bg-surface-muted px-4 py-3 text-sm text-text-secondary">{message}</p>}
    <SectionCard title="Generated report archive" description="Only draft fixture reports are currently available." className="mt-5" action={<label className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-3 text-text-muted" /><input aria-label="Search report archive" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search archive" className="h-11 rounded-md border border-border bg-surface pl-9 pr-3 text-sm" /></label>}>
      <DataTable caption="Generated report archive"><TableHead><TableHeader>Report</TableHeader><TableHeader>Period</TableHeader><TableHeader>Created</TableHeader><TableHeader>Status</TableHeader><TableHeader>PDF</TableHeader><TableHeader>CSV</TableHeader>{canManage && <TableHeader>Retry</TableHeader>}</TableHead><tbody className="divide-y divide-border">{loading ? <tr><TableCell colSpan={canManage ? 7 : 6}>Loading archive…</TableCell></tr> : visibleItems.length === 0 ? <tr><TableCell colSpan={canManage ? 7 : 6}>No draft reports yet. Generate one to validate the archive and download path without publishing financial data.</TableCell></tr> : visibleItems.map((item) => <tr key={item.id}><TableCell className="font-medium">{typeLabels[item.reportType]} draft</TableCell><TableCell>{item.periodStart} – {item.periodEnd}</TableCell><TableCell>{new Date(item.requestedAt).toLocaleString()}</TableCell><TableCell><StatusBadge status={item.status} />{item.readinessStatus === "draft_fixture_only" && <span className="mt-1 block text-xs font-medium text-warning">Draft — financial data not loaded</span>}{item.coverageSummary && <span className="mt-1 block text-xs text-text-secondary">{item.coverageSummary}</span>}{item.snapshotVersion && <span className="mt-1 block text-xs text-text-muted">Snapshot v{item.snapshotVersion}</span>}{item.safeErrorSummary && <span className="mt-1 block text-xs text-danger">{item.safeErrorSummary}</span>}</TableCell><TableCell>{item.hasPdf ? <a className="font-semibold text-brand-accent" href={`/api/reports/${item.id}/files/pdf`}>PDF</a> : "—"}</TableCell><TableCell>{item.hasCsv ? <a className="font-semibold text-brand-accent" href={`/api/reports/${item.id}/files/csv_bundle`}>CSV</a> : "—"}</TableCell>{canManage && <TableCell>{item.status === "failed" ? <button type="button" onClick={() => void retry(item.id)} className="font-semibold text-brand-accent">Retry</button> : "—"}</TableCell>}</tr>)}</tbody></DataTable>
    </SectionCard>
  </AppShell>;
}
