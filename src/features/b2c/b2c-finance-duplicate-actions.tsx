"use client";

import { useState } from "react";
import { PrimaryButton, SectionCard } from "@/components/ui";
import type { B2cFinanceActionOverview, B2cFinanceSourceTab } from "@/server/services/b2c-finance-action-center";

type RecommendationBatch = { sourceTab: B2cFinanceSourceTab; groupIds: string[] };

function recommendationsFrom(overview: B2cFinanceActionOverview): RecommendationBatch[] {
  const batches = new Map<B2cFinanceSourceTab, string[]>();
  overview.items.filter((item) => item.actionType === "duplicate" && item.sourceTab && item.actionLabel.startsWith("Keep the fuller"))
    .forEach((item) => {
      const sourceTab = item.sourceTab as B2cFinanceSourceTab;
      const groupId = item.id.replace("duplicate:", "");
      batches.set(sourceTab, [...(batches.get(sourceTab) ?? []), groupId]);
    });
  return [...batches.entries()].map(([sourceTab, groupIds]) => ({ sourceTab, groupIds }));
}

/** Presents only server-derived recommendations; every selected pair still receives an individual audited decision. */
export function B2cFinanceDuplicateActions({ overview, onChanged }: { overview: B2cFinanceActionOverview; onChanged(): void | Promise<void> }) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [savingTab, setSavingTab] = useState<B2cFinanceSourceTab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const batches = recommendationsFrom(overview);

  const save = async (batch: RecommendationBatch) => {
    setSavingTab(batch.sourceTab); setError(null); setSuccess(null);
    try {
      const response = await fetch("/api/admin/b2c/finance-actions/duplicates/bulk-canonical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIds: batch.groupIds, sourceTab: batch.sourceTab, reason }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("decidedGroups" in payload) || typeof payload.decidedGroups !== "number") {
        throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Could not save the duplicate decisions.");
      }
      setSuccess(`${payload.decidedGroups} duplicate decision${payload.decidedGroups === 1 ? "" : "s"} recorded. One record will remain eligible from each pair.`);
      setReason(""); setConfirmed(false);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the duplicate decisions. No source data was changed.");
    } finally {
      setSavingTab(null);
    }
  };

  return <SectionCard title="Duplicate payments" description="Each decision keeps one record from a proven duplicate pair. The other copy remains in the workbook history and is not added again.">
    {batches.length === 0 ? <p className="text-sm leading-6 text-text-muted">There are no high-confidence duplicate recommendations waiting for a bulk decision. Use the individual review for any equally complete pairs.</p> : <div className="space-y-4">
      <div>
        <label htmlFor="duplicate-decision-reason" className="text-sm font-medium text-text-primary">Reason for keeping B2C Cons</label>
        <p className="mt-1 text-sm leading-6 text-text-muted">This reason is stored with every decision. It does not change the uploaded workbook.</p>
        <textarea id="duplicate-decision-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} className="mt-2 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent" />
      </div>
      <label className="flex items-start gap-3 text-sm leading-6 text-text-secondary">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 rounded border-border" />
        <span>I understand that one decision will be recorded for each proven duplicate pair.</span>
      </label>
      <div className="flex flex-wrap gap-3">
        {batches.map((batch) => <PrimaryButton key={batch.sourceTab} disabled={!confirmed || reason.trim().length < 3 || savingTab !== null} onClick={() => void save(batch)}>
          {savingTab === batch.sourceTab ? "Recording…" : `Use ${batch.sourceTab} for ${batch.groupIds.length} payment${batch.groupIds.length === 1 ? "" : "s"}`}
        </PrimaryButton>)}
      </div>
    </div>}
    {success && <p className="mt-4 rounded-md border border-success/25 bg-success/5 p-3 text-sm text-success" role="status">{success}</p>}
    {error && <p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
  </SectionCard>;
}
