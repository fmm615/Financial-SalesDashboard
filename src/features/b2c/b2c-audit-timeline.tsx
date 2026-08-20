"use client";

import { useEffect, useState } from "react";

export type B2cAuditTimelineEntry = {
  id: string;
  area: string;
  correctionType: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  effectiveOn: string | null;
  createdAt: string;
};

const CORRECTION_TYPE_LABEL: Record<string, string> = {
  amount: "Amount correction",
  date: "Reporting date correction",
  category: "Category correction",
  other: "Verified correction",
};

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bahrain" }).format(new Date(value));
}

/**
 * The drawer's "Audit history" section: every append-only correction,
 * exception, FX conversion, and posted-adjustment entry recorded against
 * this payment or refund, oldest information never overwritten -- only ever
 * added to. Both an Admin and a Viewer may read it.
 */
export function B2cAuditTimeline({ recordId }: { recordId: string }) {
  const [entries, setEntries] = useState<B2cAuditTimelineEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null); setLoadError(false);
    fetch(`/api/b2c/payments/${recordId}/audit-history`, { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{ entries: B2cAuditTimelineEntry[] }>; })
      .then((payload) => { if (!cancelled) setEntries(payload.entries); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [recordId]);

  if (loadError) return <p className="text-sm text-danger" role="alert">Audit history could not be loaded.</p>;
  if (!entries) return <p className="text-sm text-text-muted">Loading audit history…</p>;
  if (entries.length === 0) return <p className="text-sm text-text-muted">No audited corrections, exceptions, or adjustments have been recorded for this record yet.</p>;

  return <ol className="space-y-3">
    {entries.map((entry) => <li key={entry.id} className="rounded-input border border-border bg-surface-muted/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-primary">{CORRECTION_TYPE_LABEL[entry.correctionType] ?? "Verified correction"}</span>
        <span className="text-xs text-text-muted">{formatTimestamp(entry.createdAt)}</span>
      </div>
      {entry.reason && <p className="mt-2 text-sm leading-6 text-text-secondary">{entry.reason}</p>}
    </li>)}
  </ol>;
}
