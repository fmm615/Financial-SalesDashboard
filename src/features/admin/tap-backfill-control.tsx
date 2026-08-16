"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";

type BackfillResult = { runId: string; processed: number; failed: number; totalProcessed: number; totalFailed: number; hasMore: boolean };

/** Runs small persisted Tap history pages so closing the browser is safe. */
export function TapBackfillControl() {
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  async function runBackfill() {
    setRunning(true); setError(null);
    try {
      let next: BackfillResult | null = null;
      do {
        const response = await fetch("/api/admin/tap/backfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        const body = await response.json() as BackfillResult & { error?: string };
        if (!response.ok || !("runId" in body)) throw new Error(body.error ?? "Tap backfill could not be completed.");
        next = body; setResult(next);
        if (next.hasMore) await new Promise((resolve) => window.setTimeout(resolve, 300));
      } while (next.hasMore);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Tap backfill could not be completed."); } finally { setRunning(false); }
  }
  return <div className="border border-line bg-stone p-6">
    <p className="font-medium text-ink">Historical Tap B2C backfill</p>
    <p className="mt-2 max-w-2xl text-sm text-slate-600">Imports Tap charges and refunds in persisted pages of up to 50 provider records. It can be safely resumed and never writes to Tap.</p>
    <div className="mt-5"><PrimaryButton onClick={runBackfill} disabled={running}>{running ? "Importing historical Tap payments…" : "Start or resume historical Tap import"}</PrimaryButton></div>
    {result && <p className="mt-4 text-sm text-emerald-700">Latest page: {result.processed} processed, {result.failed} flagged. Total: {result.totalProcessed} processed, {result.totalFailed} flagged.{result.hasMore ? " More records remain; continuing automatically." : " Historical Tap import complete."}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
  </div>;
}
