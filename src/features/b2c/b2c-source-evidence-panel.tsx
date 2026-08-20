"use client";

import { useEffect, useState } from "react";
import { useCanManage } from "@/lib/auth/role-context";
import type { B2cStripeEvidence } from "@/server/repositories/b2c-dashboard-repository";

type EvidenceValue = string | number | null | undefined;

function valueOrDash(value: EvidenceValue): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  return value?.trim() || "—";
}

function money(value: EvidenceValue, currency: EvidenceValue): string {
  const shownValue = valueOrDash(value);
  const shownCurrency = valueOrDash(currency);
  return shownValue !== "—" && shownCurrency !== "—" ? `${shownValue} ${shownCurrency}` : "—";
}

function EvidenceField({ label, value }: { label: string; value: EvidenceValue }) {
  return <div className="min-w-0 rounded-lg border border-border bg-surface-muted px-3 py-2.5">
    <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
    <dd className="mt-1 break-words text-sm font-medium text-text-primary">{valueOrDash(value)}</dd>
  </div>;
}

type AdminEvidenceResponse = {
  paymentId: string;
  source: string;
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";
  providerReference: string | null;
  date: string;
  stripeEvidence: B2cStripeEvidence | null;
};

/**
 * The drawer's "Source evidence" section. Source evidence is never editable
 * here -- it only ever displays retained, read-only provider facts. A Stripe
 * payment's full charge/settlement/refund evidence is Admin-only and never
 * part of the Viewer-safe `/api/b2c/workspace` response (Task 3 strips it by
 * design), so this panel loads it itself, only for an Admin, through the
 * dedicated `/api/admin/b2c/payments/[paymentId]/evidence` read.
 */
export function B2cSourceEvidencePanel({
  paymentId,
  recordType,
  source,
  sourceSystem,
  providerReference,
  date,
}: {
  paymentId: string;
  recordType: "Payment" | "Refund" | "Tap statement sale";
  source: string;
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";
  providerReference: string | null;
  date: string;
}) {
  const canManage = useCanManage();
  const isStripePayment = recordType === "Payment" && sourceSystem === "stripe";
  const [evidence, setEvidence] = useState<AdminEvidenceResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canManage || !isStripePayment) { setEvidence(null); setLoadError(false); return; }
    let cancelled = false;
    setLoading(true); setLoadError(false);
    fetch(`/api/admin/b2c/payments/${paymentId}/evidence`, { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<AdminEvidenceResponse>; })
      .then((payload) => { if (!cancelled) setEvidence(payload); })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [canManage, isStripePayment, paymentId]);

  return <div>
    <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm text-text-secondary">
      <span className="font-medium text-text-primary">{source} reference:</span> <span className="break-all font-mono text-xs">{valueOrDash(providerReference)}</span>
      <span className="mx-2 text-text-muted">•</span>
      <span>{date}</span>
    </div>

    {!isStripePayment && <p className="mt-3 text-sm leading-6 text-text-muted">No further source evidence is retained beyond the values shown in Summary.</p>}

    {isStripePayment && !canManage && <p className="mt-3 text-sm leading-6 text-text-muted">Full Stripe charge and settlement evidence is Admin-only.</p>}

    {isStripePayment && canManage && loading && <p className="mt-3 text-sm text-text-muted">Loading Stripe evidence…</p>}
    {isStripePayment && canManage && loadError && <p className="mt-3 text-sm text-danger" role="alert">Stripe evidence could not be loaded.</p>}

    {isStripePayment && canManage && evidence?.stripeEvidence && <>
      <section className="mt-5">
        <h3 className="text-sm font-semibold text-text-primary">Charge evidence</h3>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <EvidenceField label="Currency" value={evidence.stripeEvidence.originalCurrency} />
          <EvidenceField label="Original amount" value={money(evidence.stripeEvidence.originalAmount, evidence.stripeEvidence.originalCurrency)} />
          <EvidenceField label="Amount refunded" value={money(evidence.stripeEvidence.amountRefunded, evidence.stripeEvidence.originalCurrency)} />
          <EvidenceField label="Description" value={evidence.stripeEvidence.description} />
          <EvidenceField label="Seller message" value={evidence.stripeEvidence.sellerMessage} />
          <EvidenceField label="Cardholder name" value={evidence.stripeEvidence.cardholderName} />
        </dl>
      </section>

      <section className="mt-5 border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-text-primary">Stripe settlement evidence</h3>
        <p className="mt-1 text-sm leading-6 text-text-secondary">The converted values are Stripe settlement evidence. They do not replace the source charge amount or the separate USD reporting amount.</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <EvidenceField label="Converted amount (gross)" value={money(evidence.stripeEvidence.settlementGrossAmount, evidence.stripeEvidence.settlementCurrency)} />
          <EvidenceField label="Converted currency" value={evidence.stripeEvidence.settlementCurrency} />
          <EvidenceField label="Stripe exchange rate" value={evidence.stripeEvidence.settlementExchangeRate} />
          <EvidenceField label="Fee" value={money(evidence.stripeEvidence.settlementFeeAmount, evidence.stripeEvidence.settlementCurrency)} />
          <EvidenceField label="Taxes on fee" value={money(evidence.stripeEvidence.settlementFeeTaxAmount, evidence.stripeEvidence.settlementCurrency)} />
          <EvidenceField label="Net payout" value={money(evidence.stripeEvidence.settlementNetAmount, evidence.stripeEvidence.settlementCurrency)} />
        </dl>
      </section>

      <section className="mt-5 border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-text-primary">Refunds</h3>
        {evidence.stripeEvidence.refunds.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No Stripe refunds are linked to this payment.</p> : <div className="mt-3 space-y-3">
          {evidence.stripeEvidence.refunds.map((refund) => <div key={refund.refundId} className="rounded-lg border border-border p-3">
            <p className="break-all font-mono text-xs text-text-muted">{refund.refundId}</p>
            <p className="mt-2 text-sm font-medium text-text-primary">{refund.settlementRefundAmount && refund.settlementCurrency ? `${refund.originalAmount} ${refund.originalCurrency} → ${refund.settlementRefundAmount} ${refund.settlementCurrency}` : `${refund.originalAmount} ${refund.originalCurrency}`}</p>
            <p className="mt-1 text-sm text-text-secondary">Amount refunded · Stripe exchange rate: {valueOrDash(refund.settlementExchangeRate)}</p>
          </div>)}
        </div>}
      </section>
    </>}
  </div>;
}
