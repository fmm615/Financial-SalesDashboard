"use client";

import { useEffect, useState } from "react";

type IntegrationProvider = "stripe" | "tap" | "hubspot";
type IntegrationBackfillStatus = "not_started" | "pending" | "processing" | "completed" | "failed" | "cancelled";
type IntegrationBackfillSummary = {
  provider: IntegrationProvider;
  status: IntegrationBackfillStatus;
  totalProcessed: number | null;
  totalFailed: number | null;
  completedAt: string | null;
  safeErrorSummary: string | null;
};

const providerLabels: Record<IntegrationProvider, string> = { stripe: "Stripe", tap: "Tap", hubspot: "HubSpot" };
const statusLabels: Record<IntegrationBackfillStatus, string> = { not_started: "Not started", pending: "Pending", processing: "Processing", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

function isSummary(value: unknown): value is IntegrationBackfillSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return (summary.provider === "stripe" || summary.provider === "tap" || summary.provider === "hubspot")
    && (summary.status === "not_started" || summary.status === "pending" || summary.status === "processing" || summary.status === "completed" || summary.status === "failed" || summary.status === "cancelled")
    && (typeof summary.totalProcessed === "number" || summary.totalProcessed === null)
    && (typeof summary.totalFailed === "number" || summary.totalFailed === null)
    && (typeof summary.completedAt === "string" || summary.completedAt === null)
    && (typeof summary.safeErrorSummary === "string" || summary.safeErrorSummary === null);
}

function formatCompletion(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Completion time unavailable" : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Displays persisted local run data and deliberately makes no provider request. */
export function IntegrationRunSummary({ refreshToken }: { refreshToken: number }) {
  const [summaries, setSummaries] = useState<IntegrationBackfillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/admin/integrations/backfill-status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Saved status request failed.");
        const payload = await response.json() as { summaries?: unknown };
        if (!Array.isArray(payload.summaries) || !payload.summaries.every(isSummary)) throw new Error("Saved status response was invalid.");
        if (active) {
          setSummaries(payload.summaries);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setSummaries(null);
          setError("Saved run history could not be loaded.");
        }
      });
    return () => { active = false; };
  }, [refreshToken]);

  if (error) return <p role="alert" className="mb-4 rounded-md border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</p>;
  if (!summaries) return <p className="mb-4 text-sm text-text-muted">Loading saved integration runs…</p>;

  return <section aria-label="Saved integration runs" className="mb-4 grid gap-3 lg:grid-cols-3">
    {summaries.map((summary) => <article key={summary.provider} className="rounded-card border border-border bg-surface-muted/60 p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-text-primary">{providerLabels[summary.provider]}</h3><span className="rounded-full bg-surface px-2 py-1 text-xs font-medium text-text-secondary">{statusLabels[summary.status]}</span></div>
      {summary.totalProcessed === null ? <p className="mt-3 text-sm text-text-muted">No historical backfill has run.</p> : <p className="mt-3 text-sm text-text-secondary">{summary.totalProcessed.toLocaleString("en-US")} processed · {summary.totalFailed?.toLocaleString("en-US") ?? "0"} flagged</p>}
      {summary.completedAt && <p className="mt-2 text-xs text-text-muted">Completed {formatCompletion(summary.completedAt)}</p>}
      {summary.safeErrorSummary && <p role="alert" className="mt-2 text-xs leading-5 text-danger">{summary.safeErrorSummary}</p>}
    </article>)}
  </section>;
}
