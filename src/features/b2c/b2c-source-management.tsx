"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { SectionCard } from "@/components/ui";
import { useCanManage } from "@/lib/auth/role-context";
import { StripeSyncControl } from "@/features/admin/stripe-sync-control";
import { StripeBackfillControl } from "@/features/admin/stripe-backfill-control";
import { TapSyncControl } from "@/features/admin/tap-sync-control";
import { TapBackfillControl } from "@/features/admin/tap-backfill-control";

type B2cSourceProvider = "stripe" | "tap";

function SourceCard({ title, description, highlighted, cardRef, children }: {
  title: string;
  description: string;
  highlighted: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  children?: React.ReactNode;
}) {
  return <div
    ref={cardRef}
    role="region"
    aria-label={`${title} source controls`}
    tabIndex={highlighted ? -1 : undefined}
    className={highlighted ? "rounded-card ring-2 ring-warning ring-offset-2 ring-offset-surface" : undefined}
  >
    <SectionCard title={title} description={description}>
      {highlighted && <p role="status" className="mb-3 rounded-input border border-warning/30 bg-warning/5 px-3 py-2 text-sm font-medium text-warning">Failed source run selected from the Work queue.</p>}
      {children}
    </SectionCard>
  </div>;
}

/**
 * Sources owns read-only provider sync/backfill -- the one place these
 * actions live. Viewers see nothing here; every action control is
 * Admin-only. The Payment Tracker workbook, Tap statement, and Stripe
 * Charges upload flows that used to live on this tab have been removed: the
 * Finance workbook is no longer cross-referenced against Stripe/Tap. Manual
 * bank transfer entry (which writes a new financial record, not a read-only
 * sync) lives on the Ledger tab instead -- see b2c-workspace.tsx.
 */
export function B2cSourceManagement({ focusProvider = null, focusAction = null }: {
  focusProvider?: B2cSourceProvider | null;
  focusAction?: "backfill" | null;
}) {
  const canManage = useCanManage();
  const [stripeMore, setStripeMore] = useState(focusProvider === "stripe" && focusAction === "backfill");
  const [tapMore, setTapMore] = useState(focusProvider === "tap" && focusAction === "backfill");
  const stripeCardRef = useRef<HTMLDivElement>(null);
  const tapCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusProvider) return;
    if (focusAction === "backfill") {
      if (focusProvider === "stripe") setStripeMore(true);
      if (focusProvider === "tap") setTapMore(true);
    }
    const target = focusProvider === "stripe" ? stripeCardRef.current : tapCardRef.current;
    target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [focusAction, focusProvider]);

  return <div className="space-y-4">
    <div className="grid gap-4 md:grid-cols-2">
      <SourceCard title="Stripe" description="Reads Stripe charges and refunds. PLAYBOOK never sends a write request to Stripe." highlighted={focusProvider === "stripe"} cardRef={stripeCardRef}>
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

      <SourceCard title="Tap" description="Reads Tap charges and refunds. PLAYBOOK never creates, changes, refunds, or deletes Tap data." highlighted={focusProvider === "tap"} cardRef={tapCardRef}>
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
    </div>
  </div>;
}
