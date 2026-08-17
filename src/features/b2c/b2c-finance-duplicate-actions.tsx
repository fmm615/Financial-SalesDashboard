"use client";

import { useState } from "react";
import { PrimaryButton, SectionCard } from "@/components/ui";
import { B2cFinancePaymentEvidence } from "@/features/b2c/b2c-finance-payment-evidence";
import type { B2cFinanceActionOverview } from "@/server/services/b2c-finance-action-center";

const initialSelections = (overview: B2cFinanceActionOverview) => Object.fromEntries(overview.duplicateGroups.flatMap((group) => {
  const id = group.recommendation.canonicalFinanceRowId;
  return group.recommendation.eligibleForBulk && id ? [[group.groupId, id]] : [];
}));

/** Lets Finance inspect each exact workbook pair, select the retained row, then save one audited batch. */
export function B2cFinanceDuplicateActions({ overview, onChanged }: { overview: B2cFinanceActionOverview; onChanged(): void | Promise<void> }) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>(() => initialSelections(overview));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const selectedEntries = Object.entries(selections).filter(([, financeRowId]) => Boolean(financeRowId));
  const recommendedCount = overview.duplicateGroups.filter((group) => group.recommendation.eligibleForBulk).length;
  const unselectedCount = overview.duplicateGroups.length - selectedEntries.length;

  const choose = (groupId: string, financeRowId: string) => setSelections((current) => ({ ...current, [groupId]: financeRowId }));
  const remove = (groupId: string) => setSelections((current) => {
    const next = { ...current }; delete next[groupId]; return next;
  });
  const save = async () => {
    setSaving(true); setError(null); setSuccess(null);
    try {
      const response = await fetch("/api/admin/b2c/finance-actions/duplicates/selected", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions: selectedEntries.map(([groupId, financeRowId]) => ({ groupId, financeRowId })), reason }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("decidedGroups" in payload) || typeof payload.decidedGroups !== "number") {
        throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Could not record the selected duplicate decisions.");
      }
      setSuccess(`${payload.decidedGroups} duplicate decision${payload.decidedGroups === 1 ? "" : "s"} recorded. The original workbook rows remain unchanged.`);
      setReason(""); setConfirmed(false); setSelections({}); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not record the selected duplicate decisions. No source data was changed."); }
    finally { setSaving(false); }
  };

  return <SectionCard title="Duplicate payments" description="Review both workbook copies before choosing the one that can remain eligible. The other copy stays in source history and is not added again.">
    {overview.duplicateGroups.length === 0 ? <p className="text-sm leading-6 text-text-muted">There are no exact duplicate payment pairs awaiting a Finance decision.</p> : <div className="space-y-5">
      <div className="rounded-md border border-border bg-surface-muted/60 p-4 text-sm text-text-secondary"><span className="font-semibold text-text-primary">{selectedEntries.length} selected payment pair{selectedEntries.length === 1 ? "" : "s"}</span> · {recommendedCount} safely recommended · {unselectedCount} awaiting an explicit choice</div>
      <div className="space-y-4">
        {overview.duplicateGroups.map((group, index) => {
          const selected = selections[group.groupId];
          const recommendation = group.recommendation;
          return <details key={group.groupId} open={index < 3} className="rounded-md border border-border bg-surface">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-text-primary">Payment pair {index + 1} · {selected ? "Selection ready" : "Choose a record"}</summary>
            <div className="border-t border-border p-4">
              {recommendation.eligibleForBulk && recommendation.sourceTab ? <p className="mb-4 rounded-md bg-success/10 px-3 py-2 text-sm text-success">Recommended: keep {recommendation.sourceTab}; it has more usable Finance information.</p> : <p className="mb-4 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">No automatic recommendation. These records are equally complete, so choose one after review.</p>}
              <div className="grid gap-4 xl:grid-cols-2">{group.rows.map((row) => <div key={row.financeRowId} className="space-y-3"><B2cFinancePaymentEvidence evidence={row} heading={`${row.sourceTab} row ${row.sourceRowNumber}`} /><div className="flex flex-wrap gap-2"><button type="button" onClick={() => choose(group.groupId, row.financeRowId)} className={`min-h-10 rounded-pill border px-4 py-2 text-sm font-semibold ${selected === row.financeRowId ? "border-brand-accent bg-brand-accent text-white" : "border-border bg-surface text-text-secondary hover:border-brand-accent"}`}>Keep {row.sourceTab}</button>{selected === row.financeRowId && <button type="button" onClick={() => remove(group.groupId)} className="min-h-10 rounded-pill px-3 text-sm font-medium text-text-muted underline underline-offset-4">Leave undecided</button>}</div></div>)}</div>
            </div>
          </details>;
        })}
      </div>
      <div className="border-t border-border pt-5">
        <label htmlFor="duplicate-decision-reason" className="text-sm font-medium text-text-primary">Reason for recording these duplicate decisions</label>
        <p className="mt-1 text-sm leading-6 text-text-muted">This reason is stored with every selected decision. It does not change the uploaded workbook.</p>
        <textarea id="duplicate-decision-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} className="mt-2 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-accent" />
        <label className="mt-4 flex items-start gap-3 text-sm leading-6 text-text-secondary"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 rounded border-border" /><span>I understand that one audited decision will be recorded for each selected pair.</span></label>
        <div className="mt-4"><PrimaryButton disabled={selectedEntries.length === 0 || !confirmed || reason.trim().length < 3 || saving} onClick={() => void save()}>{saving ? "Recording…" : "Record selected duplicate decisions"}</PrimaryButton></div>
      </div>
    </div>}
    {success && <p className="mt-4 rounded-md border border-success/25 bg-success/5 p-3 text-sm text-success" role="status">{success}</p>}
    {error && <p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
  </SectionCard>;
}
