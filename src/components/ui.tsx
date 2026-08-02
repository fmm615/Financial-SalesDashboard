"use client";

import { motion } from "framer-motion";
import { AlertTriangle, ChevronDown, CircleAlert, Loader2, Search, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { formatUsd } from "@/lib/format";
import type { MetricTone, RecordStatus, ReviewFlag } from "@/types/dashboard";

const statusStyles: Record<string, string> = {
  Completed: "bg-emerald-50 text-emerald-800 ring-emerald-200", Open: "bg-amber-50 text-amber-800 ring-amber-200", Pending: "bg-sky-50 text-sky-800 ring-sky-200", Processing: "bg-sky-50 text-sky-800 ring-sky-200", Failed: "bg-rose-50 text-rose-800 ring-rose-200", Refunded: "bg-violet-50 text-violet-800 ring-violet-200", Resolved: "bg-slate-100 text-slate-700 ring-slate-200", "Not loaded": "bg-slate-100 text-slate-600 ring-slate-200",
};

export function StatusBadge({ status }: { status: RecordStatus | ReviewFlag | string }) { return <span className={`inline-flex whitespace-nowrap items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${statusStyles[status] ?? "bg-slate-100 text-slate-700 ring-slate-200"}`}>{status}</span>; }

export function SectionCard({ title, description, action, children, className = "" }: { title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`border border-line bg-white shadow-card ${className}`}>{(title || action) && <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4"><div>{title && <h2 className="text-base font-medium text-ink">{title}</h2>}{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>{action}</div>}<div className="p-5">{children}</div></section>;
}

export function MetricCard({ label, value, note, tone = "neutral" }: { label: string; value: number | string | null; note: string; tone?: MetricTone }) {
  const toneClass = { positive: "text-emerald-700", neutral: "text-slate-500", warning: "text-amber-700", danger: "text-rose-700" }[tone];
  return <motion.article initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="border border-line bg-white p-5 shadow-card"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-medium tracking-tight text-ink">{typeof value === "number" ? formatUsd(value) : value ?? "—"}</p><p className={`mt-2 text-xs ${toneClass}`}>{note}</p></motion.article>;
}

export function ProgressMetric({ label, value, target, progress }: { label: string; value: string; target: string; progress: number }) { return <div><div className="flex items-baseline justify-between gap-2"><span className="text-sm text-slate-600">{label}</span><span className="text-sm font-medium text-ink">{value}</span></div><div className="mt-2 h-1.5 bg-slate-100"><div className="h-full bg-forest" style={{ width: `${progress}%` }} /></div><p className="mt-1 text-xs text-slate-500">Target {target} · {progress}%</p></div>; }

export function DateRangeSelector() { return <button type="button" className="inline-flex items-center gap-2 border border-line bg-white px-3 py-2 text-sm text-slate-700 hover:border-slate-400" aria-label="Select reporting date range">1–31 August 2026 <ChevronDown size={15} /></button>; }

export function FilterBar({ filters = ["Date", "Status"] }: { filters?: string[] }) { return <div className="flex flex-wrap items-center gap-2"><label className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-slate-400" /><input aria-label="Search records" placeholder="Search records" className="h-9 border border-line bg-white pl-9 pr-3 text-sm placeholder:text-slate-400" /></label>{filters.map((filter) => <button key={filter} type="button" className="inline-flex h-9 items-center gap-2 border border-line bg-white px-3 text-sm text-slate-600">{filter}<ChevronDown size={14} /></button>)}<button type="button" className="inline-flex h-9 items-center gap-2 px-2 text-sm text-forest"><SlidersHorizontal size={15} />More filters</button></div>; }

export function DataTable({ children, caption }: { children: ReactNode; caption: string }) { return <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><caption className="sr-only">{caption}</caption>{children}</table></div>; }
export function TableHead({ children }: { children: ReactNode }) { return <thead className="border-y border-line bg-stone text-xs font-medium uppercase tracking-wide text-slate-500"><tr>{children}</tr></thead>; }
export function TableHeader({ children }: { children: ReactNode }) { return <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">{children}</th>; }
export function TableCell({ children, className = "" }: { children: ReactNode; className?: string }) { return <td className={`whitespace-nowrap px-4 py-3 align-top text-slate-700 ${className}`}>{children}</td>; }

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) { return <div aria-label="Loading data" className="space-y-3">{Array.from({ length: rows }, (_, index) => <div key={index} className="h-5 w-full animate-pulse bg-slate-100" />)}</div>; }
export function EmptyState({ title = "No records yet", description = "Records will appear here when they are available." }: { title?: string; description?: string }) { return <div className="py-10 text-center"><p className="font-medium text-ink">{title}</p><p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{description}</p></div>; }
export function ErrorState({ title = "Unable to load this section", description = "Please try again. If the issue continues, contact the finance team." }: { title?: string; description?: string }) { return <div role="alert" className="flex gap-3 border border-rose-200 bg-rose-50 p-4 text-rose-900"><CircleAlert className="shrink-0" size={18} /><div><p className="font-medium">{title}</p><p className="mt-1 text-sm">{description}</p></div></div>; }
export function NotBackfilledState({ title = "Historical data not available", description = "This period has not yet been backfilled. It is intentionally not shown as zero." }: { title?: string; description?: string }) { return <div className="flex gap-3 border border-slate-200 bg-slate-50 p-4"><AlertTriangle className="shrink-0 text-slate-500" size={18} /><div><p className="font-medium text-slate-700">{title}</p><p className="mt-1 text-sm text-slate-500">{description}</p></div></div>; }
export function PermissionRestrictedState() { return <div className="border border-line bg-stone p-6 text-center"><p className="font-medium text-ink">Access restricted</p><p className="mt-1 text-sm text-slate-500">Your role does not include access to this area.</p></div>; }
export function PrimaryButton({ children, onClick, disabled = false }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) { return <button type="button" onClick={onClick} disabled={disabled} className="inline-flex items-center justify-center gap-2 bg-forest px-4 py-2 text-sm font-medium text-white hover:bg-[#103b2d] disabled:cursor-not-allowed disabled:opacity-60">{children}</button>; }
export function SubtleLoading() { return <span className="inline-flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" />Loading</span>; }
