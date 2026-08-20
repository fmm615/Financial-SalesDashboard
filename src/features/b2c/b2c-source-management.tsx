"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingSkeleton, SectionCard, StatusBadge } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import { StripeSyncControl } from "@/features/admin/stripe-sync-control";
import { StripeBackfillControl } from "@/features/admin/stripe-backfill-control";
import { TapSyncControl } from "@/features/admin/tap-sync-control";
import { TapBackfillControl } from "@/features/admin/tap-backfill-control";
import { B2cPaymentTrackerUpload } from "@/features/b2c/b2c-payment-tracker-upload";
import { B2cTapStatementUpload } from "@/features/b2c/b2c-tap-statement-upload";
import { B2cStripeChargesUpload } from "@/features/b2c/b2c-stripe-charges-upload";
import type { B2cReconciliationSafeSummaryWithReplacement } from "@/server/repositories/b2c-finance-reconciliation-repository";

function displaySourceStatus(status: B2cReconciliationSafeSummaryWithReplacement["sources"][number]["status"]): string {
  return status === "not_loaded" ? "Not loaded" : status[0].toUpperCase() + status.slice(1);
}

function SourceCard({ title, description, status, children }: { title: string; description: string; status?: string; children?: React.ReactNode }) {
  return <SectionCard title={title} description={description} action={status ? <StatusBadge status={status} /> : undefined}>
    {children}
  </SectionCard>;
}

/**
 * Sources owns provider sync, backfill, evidence upload, Payment Tracker
 * import/replace, and manual bank transfer intake -- the one place these
 * actions live (see "One Owner Per Workflow" in the implementation plan).
 * Viewers see coverage/import history only; every action control is Admin-only.
 */
export function B2cSourceManagement() {
  const canManage = useCanManage();
  const [summary, setSummary] = useState<B2cReconciliationSafeSummaryWithReplacement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [stripeMore, setStripeMore] = useState(false);
  const [tapMore, setTapMore] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch("/api/b2c/reconciliation", { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("summary" in payload)) throw new Error("Summary unavailable");
      setSummary(payload.summary as B2cReconciliationSafeSummaryWithReplacement);
    } catch {
      setSummary(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const stripeSource = summary?.sources.find((source) => source.key === "stripe_charges");
  const paymentTrackerSource = summary?.sources.find((source) => source.key === "payment_tracker");
  const tapSource = summary?.sources.find((source) => source.key === "tap_statement");
  const paymentTrackerCompleted = paymentTrackerSource?.status === "completed";

  if (!summary && !loadError) return <SectionCard title="Loading source coverage" description="Preparing Stripe, Tap, Payment Tracker, and manual bank transfer coverage."><LoadingSkeleton rows={4} /></SectionCard>;
  if (!summary) return <ErrorState title="Unable to load source coverage" description="No import state or financial value has been changed. Please try again." />;

  return <div className="space-y-4">
    <div className="grid gap-4 md:grid-cols-2">
      <SourceCard title="Stripe" description="Reads Stripe charges and refunds. PLAYBOOK never sends a write request to Stripe." status={stripeSource ? displaySourceStatus(stripeSource.status) : undefined}>
        {canManage ? <>
          <StripeSyncControl />
          <details className="mt-3 group" open={stripeMore} onToggle={(event) => setStripeMore((event.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer list-none text-sm font-medium text-brand-accent">{stripeMore ? "Hide more actions" : "More actions"}</summary>
            <div className="mt-3 space-y-3">
              <StripeBackfillControl onRunSettled={() => void loadSummary()} />
              <B2cStripeChargesUpload onImported={() => void loadSummary()} />
            </div>
          </details>
        </> : <p className="text-sm leading-6 text-text-muted">Coverage and import history only. Sync and evidence upload require Admin access.</p>}
      </SourceCard>

      <SourceCard title="Tap" description="Reads Tap charges and refunds. PLAYBOOK never creates, changes, refunds, or deletes Tap data." status={tapSource ? displaySourceStatus(tapSource.status) : undefined}>
        {canManage ? <>
          <TapSyncControl />
          <details className="mt-3 group" open={tapMore} onToggle={(event) => setTapMore((event.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer list-none text-sm font-medium text-brand-accent">{tapMore ? "Hide more actions" : "More actions"}</summary>
            <div className="mt-3 space-y-3">
              <TapBackfillControl onRunSettled={() => void loadSummary()} />
              <B2cTapStatementUpload onImported={() => void loadSummary()} />
            </div>
          </details>
        </> : <p className="text-sm leading-6 text-text-muted">Coverage and import history only. Sync and evidence upload require Admin access.</p>}
      </SourceCard>

      <SourceCard title="Payment Tracker" description="Finance-approved iOS and bank-transfer revenue candidates, imported from one workbook." status={paymentTrackerSource ? displaySourceStatus(paymentTrackerSource.status) : undefined}>
        {canManage ? <B2cPaymentTrackerUpload hasExistingImport={paymentTrackerCompleted} supersedesImportId={summary.latestCompletedPaymentTrackerImportId} onImported={() => void loadSummary()} /> : <p className="text-sm leading-6 text-text-muted">Coverage and import history only. Import requires Admin access.</p>}
      </SourceCard>

      <SourceCard title="Manual bank transfers" description="A genuinely new bank transfer not present in Payment Tracker, entered after a reviewed duplicate check.">
        {canManage ? <p className="rounded-md border border-border bg-surface-muted/60 p-4 text-sm leading-6 text-text-muted">Coming soon. The live <span className="font-medium text-text-primary">Add bank transfer</span> flow — Step 1 facts, a server duplicate-check preview, then <span className="font-medium text-text-primary">Record bank transfer</span> — is not yet implemented.</p> : <p className="text-sm leading-6 text-text-muted">Manual bank transfer entry requires Admin access.</p>}
      </SourceCard>
    </div>

    <SectionCard title="Required source coverage" description="Every source must be complete and Finance-approved before a B2C Finance revenue period can be published.">
      <ul className="divide-y divide-border" aria-label="B2C source coverage">
        {summary.sources.map((source) => <li key={source.key} className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-text-primary">{source.label}</p>
            <p className="mt-1 text-sm text-text-muted">{source.key === "payment_tracker" ? "Finance revenue candidates, excluding customer VAT" : source.key === "tap_statement" ? "Payment and settlement evidence only; retained in original currency" : "Required payment evidence and fee context"}</p>
          </div>
          <StatusBadge status={displaySourceStatus(source.status)} />
        </li>)}
      </ul>
    </SectionCard>
  </div>;
}
