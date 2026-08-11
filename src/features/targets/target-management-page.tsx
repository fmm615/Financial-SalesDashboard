"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingSkeleton, SectionCard } from "@/components/ui";

type TargetResponse = {
  financialTargets: Array<{ id: string; metric_code: string; period_start: string; period_end: string; target_amount_usd: string; finance_reference: string }>;
  operationalTargets: Array<{ id: string; display_name: string; value_kind: "money_usd" | "quantity"; target_value: string; unit_label: string | null; period_start: string; period_end: string; finance_reference: string }>;
};

function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function usd(value: string) { return "$" + Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export function TargetManagementPage() {
  const [targets, setTargets] = useState<TargetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/targets").then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load targets.");
      setTargets(body);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load targets."));
  }, []);

  return <AppShell title="Targets" description="Approved financial goals and auditable operational goals. Financial actuals remain unavailable until verified source history is complete.">
    {error ? <ErrorState title="Targets unavailable" description={error} /> : !targets ? <LoadingSkeleton rows={4} /> : <>
      <SectionCard title="Financial targets" description="Goals approved by Finance. Actuals are calculated only from verified source records.">
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm font-medium text-text-secondary">Actuals not fully loaded</p>
        <p className="mt-2 text-sm text-text-muted">Financial progress will appear only after B2B and B2C history is complete and reconciled. Missing data is never treated as zero.</p>
        <div className="mt-5 space-y-3">{targets.financialTargets.length ? targets.financialTargets.map((target) => <div key={target.id} className="rounded-card border border-border p-4"><p className="font-semibold text-text-primary">{label(target.metric_code)}</p><p className="mt-1 text-sm text-text-muted">{target.period_start} to {target.period_end} · {target.finance_reference}</p><p className="mt-3 text-xl font-semibold tabular-nums text-text-primary">{usd(target.target_amount_usd)}</p></div>) : <EmptyState title="No financial targets yet" description="An Admin can add an approved target when Finance confirms the metric and value." />}</div>
      </SectionCard>
      <SectionCard title="Operational targets" description="Manual operational metrics are kept separate from financial reporting." className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Manual operational metric</p>
        <div className="mt-4 space-y-3">{targets.operationalTargets.length ? targets.operationalTargets.map((target) => <div key={target.id} className="rounded-card border border-border p-4"><p className="font-semibold text-text-primary">{target.display_name}</p><p className="mt-1 text-sm text-text-muted">{target.period_start} to {target.period_end} · {target.finance_reference}</p><p className="mt-3 text-xl font-semibold tabular-nums text-text-primary">{target.value_kind === "money_usd" ? usd(target.target_value) : target.target_value + " " + target.unit_label}</p></div>) : <EmptyState title="No operational targets yet" description="Custom targets, such as tickets or sponsorships, will appear here after an Admin creates one." />}</div>
      </SectionCard>
    </>}
  </AppShell>;
}

