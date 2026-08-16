"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";

type BackfillResult = { runId: string; processed: number; failed: number; totalProcessed: number; totalFailed: number; hasMore: boolean };

/** Operator control for bounded, resumable all-history B2B backfill batches. */
export function HubSpotBackfillControl({ onRunSettled }: { onRunSettled?: () => void }) {
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function runBatch() {
    setRunning(true);
    setError(null);
    try {
      let next: BackfillResult | null = null;
      do {
        const response = await fetch("/api/admin/hubspot/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // A completed historical run is retained for audit. This explicitly
          // starts a fresh run only when there is no active run to resume.
          body: JSON.stringify({ restartCompleted: true }),
        });
        const body = await response.json() as BackfillResult & { error?: string };
        if (!response.ok || !("runId" in body)) throw new Error(body.error ?? "HubSpot backfill could not be completed.");
        next = body;
        setResult(next);
        if (next.hasMore) await new Promise((resolve) => window.setTimeout(resolve, 300));
      } while (next.hasMore);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "HubSpot backfill could not be completed.");
    } finally {
      setRunning(false);
      onRunSettled?.();
    }
  }

  return <div className="border border-line bg-stone p-6">
    <p className="font-medium text-ink">Historical B2B backfill</p>
    <p className="mt-2 max-w-2xl text-sm text-slate-600">Imports every deal in the approved HubSpot B2B pipeline, including historic deals. One click continues through persisted batches of up to 50 deals, with rate-conscious provider requests. You can safely close the tab and resume later; it never writes to HubSpot.</p>
    <div className="mt-5"><PrimaryButton onClick={runBatch} disabled={running}>{running ? "Importing historical B2B deals…" : result?.hasMore ? "Resume historical backfill" : "Start or restart historical backfill"}</PrimaryButton></div>
    {result && <p className="mt-4 text-sm text-emerald-700">Latest batch: {result.processed} imported, {result.failed} flagged. Total: {result.totalProcessed} imported, {result.totalFailed} flagged.{result.hasMore ? " More deals remain; continuing automatically." : " Historical backfill complete."}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
  </div>;
}
