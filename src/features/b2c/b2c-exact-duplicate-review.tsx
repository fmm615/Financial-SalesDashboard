"use client";

import { useEffect, useState } from "react";
import type { AdminExactDuplicateGroup } from "@/server/services/b2c-exact-duplicate-review";

type Props = { onGroupsChanged: () => Promise<void> };

/**
 * Admin-only review controls for two retained Finance rows; this component
 * never calculates revenue. Exact cross-tab candidate groups are created
 * automatically during Payment Tracker finalization (Task 1's
 * `create_b2c_exact_duplicate_groups()`, invoked inside
 * `finalize_b2c_finance_import_version`); there is no manual "Find exact
 * duplicates" trigger here.
 */
export function B2cExactDuplicateReview({ onGroupsChanged }: Props) {
  const [groups, setGroups] = useState<AdminExactDuplicateGroup[]>([]);
  const [selectedRows, setSelectedRows] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/admin/b2c/reconciliation/exact-duplicates", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("groups" in payload) || !Array.isArray(payload.groups)) throw new Error();
      setGroups(payload.groups as AdminExactDuplicateGroup[]);
    } catch { setError("Could not load exact duplicate groups."); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const decide = async (group: AdminExactDuplicateGroup, decisionState: "canonical" | "excluded") => {
    const decisionReason = reasons[group.groupId]?.trim() ?? "";
    const canonicalFinanceRowId = selectedRows[group.groupId] ?? null;
    if (decisionReason.length < 3 || (decisionState === "canonical" && !canonicalFinanceRowId)) return;
    setSaving(group.groupId); setError(null);
    try {
      const response = await fetch(`/api/admin/b2c/reconciliation/${group.groupId}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionState, canonicalFinanceRowId: decisionState === "canonical" ? canonicalFinanceRowId : null, decisionReason }),
      });
      if (!response.ok) throw new Error();
      setGroups((current) => current.filter((item) => item.groupId !== group.groupId));
      await onGroupsChanged();
    } catch { setError("The Finance decision could not be saved."); }
    finally { setSaving(null); }
  };

  return <section className="mt-4 rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="exact-duplicate-review-title">
    <h2 id="exact-duplicate-review-title" className="text-lg font-semibold tracking-[-0.02em] text-text-primary">Exact Finance duplicate review</h2>
    <p className="mt-1 text-sm leading-6 text-text-secondary">Both source rows remain retained. Select one canonical Finance candidate or exclude the group with a reason. This does not publish B2C revenue.</p>
    {loading && <p className="mt-3 text-sm text-text-muted">Loading exact duplicate groups…</p>}
    {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
    {!loading && groups.length === 0 && <p className="mt-3 text-sm text-text-muted">No exact duplicate groups are awaiting a Finance decision.</p>}
    {groups.map((group) => {
      const reason = reasons[group.groupId] ?? "";
      const canConfirm = Boolean(selectedRows[group.groupId]) && reason.trim().length >= 3 && saving !== group.groupId;
      const canExclude = reason.trim().length >= 3 && saving !== group.groupId;
      return <div key={group.groupId} className="mt-4 rounded-md border border-border bg-canvas p-4">
        <div className="grid gap-3 md:grid-cols-2">{group.rows.map((row) => <label key={row.financeRowId} className="rounded-md border border-border bg-surface p-3 text-sm text-text-secondary">
          <input className="mr-2" type="radio" name={`canonical-${group.groupId}`} checked={selectedRows[group.groupId] === row.financeRowId} onChange={() => setSelectedRows((current) => ({ ...current, [group.groupId]: row.financeRowId }))} aria-label={`Use ${row.sourceTab} row ${row.sourceRowNumber} as canonical`} />
          <span className="font-semibold text-text-primary">{row.sourceTab} row {row.sourceRowNumber}</span>
          <span className="mt-2 block">{row.customerName ?? "—"} · {row.customerEmail ?? "—"} · {row.customerPhone ?? "—"}</span>
          <span className="mt-1 block">{row.occurredOn} · {row.amountUsd} USD · {row.category} · {row.paymentMethod}</span>
        </label>)}</div>
        <label className="mt-3 block text-sm font-medium text-text-primary">Decision reason<textarea aria-label="Decision reason" value={reason} onChange={(event) => setReasons((current) => ({ ...current, [group.groupId]: event.target.value }))} className="mt-1 block w-full rounded-md border border-border bg-surface p-2 text-sm text-text-primary" rows={3} /></label>
        <div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!canConfirm} onClick={() => void decide(group, "canonical")} className="rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">Confirm canonical Finance row</button><button type="button" disabled={!canExclude} onClick={() => void decide(group, "excluded")} className="rounded-md border border-danger px-4 py-2 text-sm font-semibold text-danger disabled:cursor-not-allowed disabled:opacity-50">Exclude group</button></div>
      </div>;
    })}
  </section>;
}
