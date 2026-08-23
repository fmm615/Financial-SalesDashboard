"use client";

import { useState } from "react";
import type { AdminExactDuplicateGroup } from "@/server/services/b2c-exact-duplicate-review";

type Props = { group: AdminExactDuplicateGroup; onGroupsChanged: (groupId: string) => void | Promise<void> };

/**
 * Admin-only review controls for two retained Finance rows; this component
 * never calculates revenue. Exact cross-tab candidate groups are created
 * automatically during Payment Tracker finalization (Task 1's
 * `create_b2c_exact_duplicate_groups()`, invoked inside
 * `finalize_b2c_finance_import_version`); there is no manual "Find exact
 * duplicates" trigger here.
 */
export function B2cExactDuplicateReview({ group, onGroupsChanged }: Props) {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decisionState: "canonical" | "excluded") => {
    const decisionReason = reason.trim();
    if (decisionReason.length < 3 || (decisionState === "canonical" && !selectedRowId)) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/admin/b2c/reconciliation/${group.groupId}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionState, canonicalFinanceRowId: decisionState === "canonical" ? selectedRowId : null, decisionReason }),
      });
      if (!response.ok) throw new Error();
      await onGroupsChanged(group.groupId);
    } catch { setError("The Finance decision could not be saved."); }
    finally { setSaving(false); }
  };

  const canConfirm = Boolean(selectedRowId) && reason.trim().length >= 3 && !saving;
  const canExclude = reason.trim().length >= 3 && !saving;

  return <section className="mt-4 rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="exact-duplicate-review-title">
    <h2 id="exact-duplicate-review-title" className="text-lg font-semibold tracking-[-0.02em] text-text-primary">Exact Finance duplicate review</h2>
    <p className="mt-1 text-sm leading-6 text-text-secondary">Both source rows remain retained. Select one canonical Finance candidate or exclude the group with a reason. This does not publish B2C revenue.</p>
    {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
    <div className="mt-4 rounded-md border border-border bg-canvas p-4">
        <div className="grid gap-3 md:grid-cols-2">{group.rows.map((row) => <label key={row.financeRowId} className="rounded-md border border-border bg-surface p-3 text-sm text-text-secondary">
          <input className="mr-2" type="radio" name={`canonical-${group.groupId}`} checked={selectedRowId === row.financeRowId} onChange={() => setSelectedRowId(row.financeRowId)} aria-label={`Use ${row.sourceTab} row ${row.sourceRowNumber} as canonical`} />
          <span className="font-semibold text-text-primary">{row.sourceTab} row {row.sourceRowNumber}</span>
          <span className="mt-2 block">{row.customerName ?? "—"} · {row.customerEmail ?? "—"} · {row.customerPhone ?? "—"}</span>
          <span className="mt-1 block">{row.occurredOn} · {row.amountUsd} USD · {row.category} · {row.paymentMethod}</span>
        </label>)}</div>
        <label className="mt-3 block text-sm font-medium text-text-primary">Decision reason<textarea aria-label="Decision reason" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-surface p-2 text-sm text-text-primary" rows={3} /></label>
        <div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!canConfirm} onClick={() => void decide("canonical")} className="rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">Confirm canonical Finance row</button><button type="button" disabled={!canExclude} onClick={() => void decide("excluded")} className="rounded-md border border-danger px-4 py-2 text-sm font-semibold text-danger disabled:cursor-not-allowed disabled:opacity-50">Exclude group</button></div>
    </div>
  </section>;
}
