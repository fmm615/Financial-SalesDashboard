"use client";

import { useState } from "react";
import { SectionCard } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import { StripeSyncControl } from "@/features/admin/stripe-sync-control";
import { StripeBackfillControl } from "@/features/admin/stripe-backfill-control";
import { TapSyncControl } from "@/features/admin/tap-sync-control";
import { TapBackfillControl } from "@/features/admin/tap-backfill-control";
import { B2cManualBankTransfer } from "@/features/b2c/b2c-manual-bank-transfer";

function SourceCard({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return <SectionCard title={title} description={description}>
    {children}
  </SectionCard>;
}

/**
 * Sources owns provider sync/backfill and manual bank transfer intake -- the
 * one place these actions live. Viewers see nothing here; every action
 * control is Admin-only. The Payment Tracker workbook, Tap statement, and
 * Stripe Charges upload flows that used to live on this tab have been
 * removed: the Finance workbook is no longer cross-referenced against
 * Stripe/Tap. iOS manual entry still awaits a new implementation; manual
 * bank transfer entry below already records real payments directly.
 */
export function B2cSourceManagement() {
  const canManage = useCanManage();
  const [stripeMore, setStripeMore] = useState(false);
  const [tapMore, setTapMore] = useState(false);

  return <div className="space-y-4">
    <div className="grid gap-4 md:grid-cols-2">
      <SourceCard title="Stripe" description="Reads Stripe charges and refunds. PLAYBOOK never sends a write request to Stripe.">
        {canManage ? <>
          <StripeSyncControl />
          <details className="mt-3 group" open={stripeMore} onToggle={(event) => setStripeMore((event.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer list-none text-sm font-medium text-brand-accent">{stripeMore ? "Hide more actions" : "More actions"}</summary>
            <div className="mt-3 space-y-3">
              <StripeBackfillControl />
            </div>
          </details>
        </> : <p className="text-sm leading-6 text-text-muted">Sync requires Admin access.</p>}
      </SourceCard>

      <SourceCard title="Tap" description="Reads Tap charges and refunds. PLAYBOOK never creates, changes, refunds, or deletes Tap data.">
        {canManage ? <>
          <TapSyncControl />
          <details className="mt-3 group" open={tapMore} onToggle={(event) => setTapMore((event.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer list-none text-sm font-medium text-brand-accent">{tapMore ? "Hide more actions" : "More actions"}</summary>
            <div className="mt-3 space-y-3">
              <TapBackfillControl />
            </div>
          </details>
        </> : <p className="text-sm leading-6 text-text-muted">Sync requires Admin access.</p>}
      </SourceCard>

      <SourceCard title="Manual bank transfers" description="A genuinely new bank transfer, entered after a reviewed duplicate check.">
        {canManage ? <B2cManualBankTransfer /> : <p className="text-sm leading-6 text-text-muted">Manual bank transfer entry requires Admin access.</p>}
      </SourceCard>
    </div>
  </div>;
}
