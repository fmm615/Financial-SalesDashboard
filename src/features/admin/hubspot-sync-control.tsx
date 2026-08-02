"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";

type SyncResult = { processed: number; failed: number; lookbackStart: string; lookbackEnd: string };

/** Admin operator control; the Route Handler independently verifies Admin access. */
export function HubSpotSyncControl() {
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  async function runSync() {
    setError(null);
    setResult(null);
    setIsRunning(true);
    try {
      const response = await fetch("/api/integrations/hubspot/sync", { method: "POST" });
      const body = await response.json() as SyncResult | { error?: string };
      if (!response.ok || !("processed" in body)) throw new Error("HubSpot sync could not be started. Review Integration Errors for details.");
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "HubSpot sync could not be started.");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="border border-line bg-stone p-6">
      <p className="font-medium text-ink">HubSpot B2B reconciliation</p>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">Pulls deals modified in the last 48 hours. Imported bookings remain separate from manual recognised sales; unapproved stages and invalid FX values are recorded for review instead of counted.</p>
      <div className="mt-5"><PrimaryButton onClick={runSync} disabled={isRunning}>{isRunning ? "Syncing HubSpot…" : "Sync HubSpot now"}</PrimaryButton></div>
      {result && <p className="mt-4 text-sm text-emerald-700">Sync complete: {result.processed} processed, {result.failed} sent to Integration Errors.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    </div>
  );
}
