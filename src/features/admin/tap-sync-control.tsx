"use client";

import { useState } from "react";
import { PrimaryButton } from "@/components/ui";

type SyncResult = { processed: number; failed: number; inserted: number };

/** Operator control. The server independently enforces Admin access. */
export function TapSyncControl() {
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  async function runSync() {
    setRunning(true); setError(null); setResult(null);
    try {
      const response = await fetch("/api/integrations/tap/sync", { method: "POST" });
      const body = await response.json() as SyncResult & { error?: string };
      if (!response.ok || !("processed" in body)) throw new Error(body.error ?? "Tap sync could not be started. Review Integration Errors for details.");
      setResult(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Tap sync could not be started."); } finally { setRunning(false); }
  }
  return <div className="border border-line bg-stone p-6">
    <p className="font-medium text-ink">Tap B2C reconciliation</p>
    <p className="mt-2 max-w-2xl text-sm text-slate-600">Reads Tap charges and refunds from the last 48 hours. PLAYBOOK only performs Tap list and retrieval requests; it never creates, changes, refunds, or deletes Tap data. Non-USD records remain traceable but need Finance-approved FX before reporting.</p>
    <div className="mt-5"><PrimaryButton onClick={runSync} disabled={running}>{running ? "Syncing Tap…" : "Sync Tap now"}</PrimaryButton></div>
    {result && <p className="mt-4 text-sm text-emerald-700">Sync complete: {result.processed} processed, {result.inserted} new records, {result.failed} sent to Integration Errors.</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
  </div>;
}
