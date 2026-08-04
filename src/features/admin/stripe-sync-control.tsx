"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";

type SyncResult = { processed: number; failed: number; inserted: number; lookbackStart: string; lookbackEnd: string };

/** Admin operator control; the route independently checks the authenticated role. */
export function StripeSyncControl() {
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  async function runSync() {
    setError(null);
    setResult(null);
    setIsRunning(true);
    try {
      const response = await fetch("/api/integrations/stripe/sync", { method: "POST" });
      const body = await response.json() as SyncResult | { error?: string };
      if (!response.ok || !("processed" in body)) throw new Error("error" in body && body.error ? body.error : "Stripe sync could not be started. Review Integration Errors for details.");
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stripe sync could not be started.");
    } finally {
      setIsRunning(false);
    }
  }

  return <div className="border border-line bg-stone p-6">
    <p className="font-medium text-ink">Stripe B2C reconciliation</p>
    <p className="mt-2 max-w-2xl text-sm text-slate-600">Reads Stripe charges and refunds from the last 48 hours. PLAYBOOK never sends a write request to Stripe. Unmapped products and possible duplicates are retained for Admin review and excluded from reported totals.</p>
    <div className="mt-5"><PrimaryButton onClick={runSync} disabled={isRunning}>{isRunning ? "Syncing Stripe…" : "Sync Stripe now"}</PrimaryButton></div>
    {result && <p className="mt-4 text-sm text-emerald-700">Sync complete: {result.processed} processed, {result.inserted} new records, {result.failed} sent to Integration Errors.</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
  </div>;
}
