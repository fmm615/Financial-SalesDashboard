"use client";

import { useState } from "react";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

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

/** Displays only preselected, read-only Stripe evidence; it has no provider mutation path. */
export function B2cStripeEvidenceDialog({ row }: { row: B2cLedgerRow }) {
  const [open, setOpen] = useState(false);
  if (row.recordType !== "Payment" || row.sourceSystem !== "stripe" || !row.stripeEvidence) return null;
  const evidence = row.stripeEvidence;

  return <>
    <button type="button" className="whitespace-nowrap text-sm font-medium text-brand-accent hover:underline" onClick={() => setOpen(true)}>
      View Stripe details
    </button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-primary/45 p-4" role="presentation" onMouseDown={() => setOpen(false)}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="stripe-evidence-title"
        className="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-card sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="stripe-evidence-title" className="text-xl font-semibold text-text-primary">Stripe payment details</h2>
            <p className="mt-1 text-sm leading-6 text-text-secondary">Read-only source evidence retained in PLAYBOOK. It never changes Stripe or Finance reporting.</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="shrink-0 text-sm font-medium text-text-secondary hover:text-text-primary">Close</button>
        </header>

        <div className="mt-5 rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm text-text-secondary">
          <span className="font-medium text-text-primary">Source payment:</span> <span className="break-all font-mono text-xs">{valueOrDash(row.providerReference)}</span>
          <span className="mx-2 text-text-muted">•</span>
          <span>{row.date}</span>
        </div>

        <section className="mt-5">
          <h3 className="text-sm font-semibold text-text-primary">Charge evidence</h3>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <EvidenceField label="Currency" value={evidence.originalCurrency} />
            <EvidenceField label="Original amount" value={money(evidence.originalAmount, evidence.originalCurrency)} />
            <EvidenceField label="Amount refunded" value={money(evidence.amountRefunded, evidence.originalCurrency)} />
            <EvidenceField label="Description" value={evidence.description} />
            <EvidenceField label="Seller message" value={evidence.sellerMessage} />
            <EvidenceField label="Cardholder name" value={evidence.cardholderName} />
          </dl>
        </section>

        <section className="mt-5 border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-text-primary">Stripe settlement evidence</h3>
          <p className="mt-1 text-sm leading-6 text-text-secondary">The converted values are Stripe settlement evidence. They do not replace the source charge amount or the separate USD reporting amount.</p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <EvidenceField label="Converted amount (gross)" value={money(evidence.settlementGrossAmount, evidence.settlementCurrency)} />
            <EvidenceField label="Converted currency" value={evidence.settlementCurrency} />
            <EvidenceField label="Stripe exchange rate" value={evidence.settlementExchangeRate} />
            <EvidenceField label="Fee" value={money(evidence.settlementFeeAmount, evidence.settlementCurrency)} />
            <EvidenceField label="Taxes on fee" value={money(evidence.settlementFeeTaxAmount, evidence.settlementCurrency)} />
            <EvidenceField label="Net payout" value={money(evidence.settlementNetAmount, evidence.settlementCurrency)} />
          </dl>
        </section>

        <section className="mt-5 border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-text-primary">Refunds</h3>
          {evidence.refunds.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No Stripe refunds are linked to this payment.</p> : <div className="mt-3 space-y-3">
            {evidence.refunds.map((refund) => <div key={refund.refundId} className="rounded-lg border border-border p-3">
              <p className="break-all font-mono text-xs text-text-muted">{refund.refundId}</p>
              <p className="mt-2 text-sm font-medium text-text-primary">{refund.settlementRefundAmount && refund.settlementCurrency ? `${refund.originalAmount} ${refund.originalCurrency} → ${refund.settlementRefundAmount} ${refund.settlementCurrency}` : `${refund.originalAmount} ${refund.originalCurrency}`}</p>
              <p className="mt-1 text-sm text-text-secondary">Amount refunded · Stripe exchange rate: {valueOrDash(refund.settlementExchangeRate)}</p>
            </div>)}
          </div>}
        </section>
      </section>
    </div>}
  </>;
}
