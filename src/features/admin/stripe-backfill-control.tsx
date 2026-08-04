"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";

type BackfillResult = { runId: string; processed: number; failed: number; totalProcessed: number; totalFailed: number; hasMore: boolean };

/** Operator control for bounded, resumable, all-history Stripe B2C imports. */
export function StripeBackfillControl() {
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function runBackfill() {
    setRunning(true);
    setError(null);
    try {
      let next: BackfillResult | null = null;
      do {
        const response = await fetch("/api/admin/stripe/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restartCompleted: true }),
        });
        const body = await response.json() as BackfillResult & { error?: string };
        if (!response.ok || !("runId" in body)) throw new Error(body.error ?? "Stripe backfill could not be completed.");
        next = body;
        setResult(next);
        if (next.hasMore) await new Promise((resolve) => window.setTimeout(resolve, 300));
      } while (next.hasMore);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stripe backfill could not be completed.");
    } finally {
      setRunning(false);
    }
  }

  return <div className="border border-line bg-stone p-6">
    <p className="font-medium text-ink">Historical Stripe B2C backfill</p>
    <p className="mt-2 max-w-2xl text-sm text-slate-600">Imports all Stripe charges and refunds in persisted batches of up to 100 provider records. The import can be resumed safely after closing the tab and never writes to Stripe. Source records with missing values remain visible and flagged for Admin review.</p>
    <div className="mt-5"><PrimaryButton onClick={runBackfill} disabled={running}>{running ? "Importing historical Stripe payments…" : "Start or restart historical Stripe import"}</PrimaryButton></div>
    {result && <p className="mt-4 text-sm text-emerald-700">Latest batch: {result.processed} processed, {result.failed} flagged. Total: {result.totalProcessed} processed, {result.totalFailed} flagged.{result.hasMore ? " More records remain; continuing automatically." : " Historical Stripe import complete."}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
  </div>;
}
