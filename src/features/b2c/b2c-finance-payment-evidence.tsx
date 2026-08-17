import type { B2cFinanceSourceEvidence } from "@/server/services/b2c-finance-action-center";

const display = (value: string | null) => value?.trim() || "Not provided";

/** Read-only workbook facts that make a Finance decision understandable without exposing raw provider data. */
export function B2cFinancePaymentEvidence({ evidence, heading }: { evidence: B2cFinanceSourceEvidence; heading: string }) {
  const facts: Array<[string, string]> = [
    ["Reported Date", display(evidence.reportedDateRaw)], ["Date used", display(evidence.occurredOn)],
    ["Month label", display(evidence.declaredMonth)], ["Year label", display(evidence.declaredYear)],
    ["Amount (USD)", display(evidence.amountUsd)], ["Customer", display(evidence.customerName)],
    ["Email", display(evidence.customerEmail)], ["Phone", display(evidence.customerPhone)],
    ["Category", display(evidence.category)], ["Membership", display(evidence.membershipType)],
    ["Payment method", display(evidence.paymentMethod)], ["Payment status", display(evidence.paymentStatus)],
    ["Note", display(evidence.note)],
  ];
  return <article className="rounded-md border border-border bg-canvas p-4">
    <h4 className="font-medium text-text-primary">{heading}</h4>
    <p className="mt-1 text-xs text-text-muted">Workbook row {evidence.sourceRowNumber}</p>
    <dl className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">
      {facts.map(([label, value]) => <div key={label}><dt className="text-xs font-medium text-text-muted">{label}</dt><dd className="mt-1 break-words text-sm text-text-secondary">{value}</dd></div>)}
    </dl>
    {evidence.qualityIssues.length > 0 && <p className="mt-4 rounded-md bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">Check needed: {evidence.qualityIssues.join(", ").replaceAll("_", " ")}</p>}
  </article>;
}
