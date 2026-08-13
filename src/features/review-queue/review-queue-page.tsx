"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DetailDrawer, ReviewFlagBadge } from "@/components/review-ui";
import { EmptyState, ErrorState, LoadingSkeleton, MetricCard, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import { cardReveal, staggerContainer } from "@/lib/motion";
import type {
  ReviewQueueDetail,
  ReviewQueueFilters,
  ReviewQueueFlagType,
  ReviewQueueItem,
  ReviewQueueMetrics,
} from "@/server/services/review-queue";

type ReviewQueueListPayload = { items: ReviewQueueItem[]; metrics: ReviewQueueMetrics };
type ReviewQueueDetailPayload = { item: ReviewQueueDetail };
type LoadState = "loading" | "ready" | "error";

const flagTypeOptions: Array<{ value: "all" | ReviewQueueFlagType; label: string }> = [
  { value: "all", label: "All flag types" },
  { value: "refunded", label: "Refunded" },
  { value: "failed", label: "Failed" },
  { value: "possible_duplicate", label: "Possible duplicate" },
  { value: "unmapped_product", label: "Unmapped product" },
  { value: "needs_follow_up", label: "Needs follow-up" },
  { value: "needs_fx_review", label: "Needs FX review" },
];

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload && "error" in payload && typeof payload.error === "string") return payload.error;
  return fallback;
}

function toQueryString(filters: ReviewQueueFilters): string {
  const params = new URLSearchParams({ status: filters.status });
  if (filters.flagType) params.set("flagType", filters.flagType);
  if (filters.priority) params.set("priority", String(filters.priority));
  if (filters.query) params.set("query", filters.query);
  return params.toString();
}

function QueueToolbar({ filters, onChange }: { filters: ReviewQueueFilters; onChange: (next: ReviewQueueFilters) => void }) {
  const hasFilters = filters.status !== "open" || Boolean(filters.flagType || filters.priority || filters.query);
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <label className="relative min-w-[180px] flex-1 sm:flex-none">
      <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-text-muted" />
      <input aria-label="Search review queue" value={filters.query ?? ""} onChange={(event) => onChange({ ...filters, query: event.target.value || undefined })} placeholder="Search flagged records" className="h-11 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted sm:w-52" />
    </label>
    <label className="sr-only" htmlFor="review-flag-type">Filter queue by flag type</label>
    <select id="review-flag-type" aria-label="Filter queue by flag type" value={filters.flagType ?? "all"} onChange={(event) => onChange({ ...filters, flagType: event.target.value === "all" ? undefined : event.target.value as ReviewQueueFlagType })} className="h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-secondary">
      {flagTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <label className="sr-only" htmlFor="review-priority">Filter queue by priority</label>
    <select id="review-priority" aria-label="Filter queue by priority" value={filters.priority ?? "all"} onChange={(event) => onChange({ ...filters, priority: event.target.value === "all" ? undefined : Number(event.target.value) })} className="h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-secondary">
      <option value="all">All priorities</option>
      {[1, 2, 3, 4, 5].map((priority) => <option key={priority} value={priority}>Priority {priority}</option>)}
    </select>
    <label className="sr-only" htmlFor="review-status">Filter queue by status</label>
    <select id="review-status" aria-label="Filter queue by status" value={filters.status} onChange={(event) => onChange({ ...filters, status: event.target.value as ReviewQueueFilters["status"] })} className="h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-secondary">
      <option value="open">Open</option>
      <option value="resolved">Resolved</option>
      <option value="dismissed">Dismissed</option>
      <option value="all">All statuses</option>
    </select>
    {hasFilters && <button type="button" onClick={() => onChange({ status: "open" })} className="inline-flex h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-brand-accent hover:bg-surface-accent"><SlidersHorizontal size={16} aria-hidden="true" />Clear filters</button>}
  </div>;
}

function ReviewRow({ item, onOpen }: { item: ReviewQueueItem; onOpen: () => void }) {
  const reducedMotion = useReducedMotion();
  return <motion.button variants={reducedMotion ? undefined : cardReveal} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} type="button" onClick={onOpen} className="block w-full min-w-0 px-4 py-4 text-left transition-colors hover:bg-surface-muted/65 sm:px-5 lg:grid lg:grid-cols-[minmax(128px,155px)_minmax(190px,1fr)_minmax(120px,1fr)_110px_100px] lg:items-center lg:gap-3">
    <div className="flex min-w-0 items-center justify-between gap-3 lg:block"><div className="min-w-0"><ReviewFlagBadge type={item.flagLabel} /></div><div className="shrink-0 lg:hidden"><StatusBadge status={item.status === "open" ? "Open" : item.status === "resolved" ? "Resolved" : "Dismissed"} /></div></div>
    <div className="mt-3 min-w-0 lg:mt-0"><span className="block truncate text-sm font-semibold text-text-primary">{item.sourceLabel}</span><span className="mt-1 block truncate text-sm text-text-muted">{item.reason}</span></div>
    <div className="mt-3 min-w-0 text-sm lg:mt-0"><span className="block text-xs text-text-muted lg:hidden">Next action</span><span className="block truncate text-text-secondary">{item.nextAction.label}</span></div>
    <div className="mt-3 min-w-0 lg:mt-0"><span className="mr-2 text-xs text-text-muted lg:hidden">Priority</span><StatusBadge status={`Priority ${item.priority}`} /></div>
    <div className="mt-3 hidden min-w-0 lg:block lg:mt-0"><StatusBadge status={item.status === "open" ? "Open" : item.status === "resolved" ? "Resolved" : "Dismissed"} /></div>
  </motion.button>;
}

export function ReviewQueuePage() {
  const [filters, setFilters] = useState<ReviewQueueFilters>({ status: "open" });
  const [queue, setQueue] = useState<ReviewQueueListPayload | null>(null);
  const [queueState, setQueueState] = useState<LoadState>("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewQueueDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("ready");
  const reducedMotion = useReducedMotion();
  const canManage = useCanManage();
  const queryString = useMemo(() => toQueryString(filters), [filters]);

  const loadQueue = useCallback(async () => {
    setQueueState("loading");
    try {
      const response = await fetch(`/api/review-queue?${queryString}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "Could not load review queue."));
      setQueue(payload as ReviewQueueListPayload);
      setQueueState("ready");
    } catch {
      setQueue(null);
      setQueueState("error");
    }
  }, [queryString]);

  const loadDetail = useCallback(async (flagId: string) => {
    setDetail(null);
    setDetailState("loading");
    try {
      const response = await fetch(`/api/review-queue/${flagId}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "Could not load review queue item."));
      setDetail((payload as ReviewQueueDetailPayload).item);
      setDetailState("ready");
    } catch {
      setDetailState("error");
    }
  }, []);

  useEffect(() => { void loadQueue(); }, [loadQueue]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [loadDetail, selectedId]);

  async function addNote(note: string): Promise<void> {
    if (!selectedId) throw new Error("Review queue item is not available.");
    const response = await fetch(`/api/review-queue/${selectedId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || typeof payload !== "object" || !payload || !("ok" in payload) || payload.ok !== true) {
      throw new Error(errorMessage(payload, "Could not save review note."));
    }
    await Promise.all([loadQueue(), loadDetail(selectedId)]);
  }

  const metrics = queue?.metrics;
  const noItems = queueState === "ready" && queue?.items.length === 0;
  const hasActiveFilters = filters.status !== "open" || Boolean(filters.flagType || filters.priority || filters.query);

  return <AppShell title="Review queue" description="Flags stay in historical context after resolution. This queue does not modify financial records.">
    <motion.div variants={reducedMotion ? undefined : staggerContainer} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} className="grid auto-rows-fr gap-4 sm:grid-cols-3">
      <MetricCard label="Open flags" value={metrics ? String(metrics.openCount) : "—"} note="Awaiting a source-specific review action" tone="warning" />
      <MetricCard label="Resolved this month" value={metrics ? String(metrics.resolvedThisMonthCount) : "—"} note="Retained in queue history" tone="positive" />
      <MetricCard label="High priority" value={metrics ? String(metrics.highPriorityOpenCount) : "—"} note="Open flags with priority 1 or 2" tone="danger" />
    </motion.div>
    <section className="mt-5 overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex flex-col gap-4 border-b border-border px-5 py-5 xl:flex-row xl:items-center xl:justify-between"><div><h2 className="font-semibold tracking-[-0.01em] text-text-primary">Flagged records</h2><p className="mt-1 text-sm leading-6 text-text-muted">Open a record to review its source, retained history, and safe next action.</p></div><QueueToolbar filters={filters} onChange={setFilters} /></div>
      {queueState === "loading" && <div className="p-5"><p className="mb-3 text-sm text-text-muted">Loading review queue</p><LoadingSkeleton rows={4} /></div>}
      {queueState === "error" && <div className="p-5"><ErrorState title="Unable to load review queue" description="Please try again. No review status has been changed." /></div>}
      {noItems && <EmptyState title={hasActiveFilters ? "No review items match these filters." : "No review flags are available yet."} description={hasActiveFilters ? "Change or clear the filters to see other retained review items." : "Flags will appear here when a source record needs review."} />}
      {queueState === "ready" && queue && queue.items.length > 0 && <ul className="divide-y divide-border">{queue.items.map((item) => <li key={item.id} className="min-w-0"><ReviewRow item={item} onOpen={() => setSelectedId(item.id)} /></li>)}</ul>}
    </section>
    {selectedId && detailState === "loading" && <div className="fixed inset-0 z-40 flex items-center justify-center bg-brand-primary/30"><div className="w-full max-w-xl rounded-card bg-surface p-6 shadow-elevated"><p className="mb-3 text-sm text-text-muted">Loading review detail</p><LoadingSkeleton rows={5} /></div></div>}
    {selectedId && detailState === "error" && <div className="fixed inset-0 z-40 flex items-center justify-center bg-brand-primary/30 p-4"><div className="w-full max-w-xl rounded-card bg-surface p-6 shadow-elevated"><ErrorState title="Unable to load review detail" description="No review status has been changed." /><button type="button" onClick={() => setSelectedId(null)} className="mt-4 min-h-11 rounded-md px-3 text-sm font-semibold text-brand-primary hover:bg-surface-muted">Close</button></div></div>}
    {detail && <DetailDrawer detail={detail} onClose={() => setSelectedId(null)} canAddNote={canManage} onAddNote={canManage ? addNote : undefined} />}
  </AppShell>;
}
