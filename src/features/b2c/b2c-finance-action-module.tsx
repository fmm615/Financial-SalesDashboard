"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingSkeleton, SectionCard } from "@/components/ui";
import { B2cApprovedFinancePosting } from "@/features/b2c/b2c-approved-finance-posting";
import { B2cFinanceDataQualityActions } from "@/features/b2c/b2c-finance-data-quality-actions";
import { B2cFinanceDuplicateActions } from "@/features/b2c/b2c-finance-duplicate-actions";
import type { B2cFinanceActionOverview } from "@/server/services/b2c-finance-action-center";

function isOverview(value: unknown): value is B2cFinanceActionOverview {
  return Boolean(value && typeof value === "object" && "counts" in value && "items" in value && Array.isArray(value.items));
}

function CountCard({ value, label, note }: { value: number; label: string; note: string }) {
  return <article className="rounded-card border border-border bg-surface p-5 shadow-card"><p className="text-2xl font-semibold tracking-[-0.03em] text-text-primary">{value.toLocaleString("en-US")} {label}</p><p className="mt-2 text-sm leading-6 text-text-muted">{note}</p></article>;
}

/** A focused front door for all currently live B2C Finance decisions and ledger posting. */
export function B2cFinanceActionModule() {
  const [overview, setOverview] = useState<B2cFinanceActionOverview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadOverview = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch("/api/admin/b2c/finance-actions", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      const candidate = payload && typeof payload === "object" && "overview" in payload ? payload.overview : null;
      if (!response.ok || !isOverview(candidate)) throw new Error("Overview unavailable");
      setOverview(candidate);
    } catch {
      setOverview(null); setLoadError(true);
    }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  if (!overview && !loadError) return <SectionCard title="Loading B2C Finance actions" description="Preparing the safe Finance decision queue."><LoadingSkeleton rows={4} /></SectionCard>;
  if (!overview) return <ErrorState title="Unable to load B2C Finance actions" description="No source data or ledger entry has been changed. Check that the latest migration is applied, then try again." />;

  return <div className="space-y-4">
    <section className="rounded-card border border-brand-accent/20 bg-brand-accent/5 p-5">
      <p className="text-sm font-medium text-brand-primary">B2C Finance workspace</p>
      <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-text-primary">Resolve the workbook once, then add only the verified payments.</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">This page separates duplicate decisions, information checks, and ready-to-add payments. It keeps every original workbook row intact for audit.</p>
    </section>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <CountCard value={overview.counts.duplicateDecisions} label="duplicate decisions" note={`${overview.counts.duplicateSourceRows.toLocaleString("en-US")} retained workbook rows are represented by these decisions.`} />
      <CountCard value={overview.counts.dateAuthorityActions} label="Date checks" note="Valid Dates whose Month or Year label conflicts." />
      <CountCard value={overview.counts.correctionActions} label="corrections needed" note="Rows with information Finance must verify." />
      <CountCard value={overview.counts.postedFinancePayments} label="already in B2C ledger" note="Added through the controlled Finance-ledger path; this is not a revenue total." />
    </div>
    <B2cFinanceDuplicateActions overview={overview} onChanged={loadOverview} />
    <B2cFinanceDataQualityActions overview={overview} onChanged={loadOverview} />
    <SectionCard title="Ready to add" description="Once these actions are complete, add eligible iOS and bank-transfer Finance payments to the B2C ledger. The action is idempotent and never changes the workbook or a provider." className="mt-4">
      <B2cApprovedFinancePosting onPosted={loadOverview} />
    </SectionCard>
    <p className="text-sm text-text-muted">Need to replace or stage source evidence? <a className="font-medium text-brand-accent underline underline-offset-4" href="/operations/b2c/reconciliation">Open B2C source intake</a>.</p>
  </div>;
}
