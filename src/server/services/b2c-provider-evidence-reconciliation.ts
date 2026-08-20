import type { DatabaseClient } from "@/lib/supabase/server";

/**
 * Provider transaction ID is the only automatic link key. Amount, currency,
 * date, and status are comparison facts -- never used to guess a link -- so a
 * Payment Tracker row (which has no provider transaction ID) can never be
 * automatically linked through name/amount guessing.
 */
export type ProviderEvidenceMismatchField = "amount" | "currency" | "date" | "status";

export type ProviderEvidenceRecord = {
  evidenceId: string;
  providerTransactionId: string;
  amount: string;
  currency: string;
  occurredOn: string;
};

export type LocalProviderPaymentRecord = {
  paymentId: string;
  providerTransactionId: string;
  originalAmount: string;
  originalCurrency: string;
  occurredOn: string;
  paymentStatus: "succeeded" | "failed" | "pending";
};

export type ProviderEvidenceExactMatch = { evidenceId: string; paymentId: string };
export type ProviderEvidenceMismatch = { evidenceId: string; paymentId: string; fields: ProviderEvidenceMismatchField[] };

export type ProviderEvidenceReconciliationResult = {
  exactMatches: ProviderEvidenceExactMatch[];
  mismatches: ProviderEvidenceMismatch[];
  unmatchedEvidence: string[];
};

function canonicalAmount(value: string): string {
  const [whole, fraction = ""] = value.trim().split(".");
  return `${whole.replace(/^0+(?=\d)/, "") || "0"}.${fraction.padEnd(6, "0").slice(0, 6)}`;
}

/**
 * Pure comparison: never creates a payment, never changes a financial total.
 * A row whose provider transaction ID has no local API payment is retained as
 * unmatched evidence; a matching ID with a differing amount, currency, date,
 * or status becomes a work-queue mismatch instead of a silent auto-link.
 */
export function reconcileProviderEvidence(input: {
  evidence: ProviderEvidenceRecord[];
  payments: LocalProviderPaymentRecord[];
}): ProviderEvidenceReconciliationResult {
  const paymentsByTransactionId = new Map(input.payments.map((payment) => [payment.providerTransactionId, payment]));
  const exactMatches: ProviderEvidenceExactMatch[] = [];
  const mismatches: ProviderEvidenceMismatch[] = [];
  const unmatchedEvidence: string[] = [];

  for (const evidence of input.evidence) {
    const payment = paymentsByTransactionId.get(evidence.providerTransactionId);
    if (!payment) {
      unmatchedEvidence.push(evidence.evidenceId);
      continue;
    }

    const fields: ProviderEvidenceMismatchField[] = [];
    if (canonicalAmount(evidence.amount) !== canonicalAmount(payment.originalAmount)) fields.push("amount");
    if (evidence.currency.trim().toUpperCase() !== payment.originalCurrency.trim().toUpperCase()) fields.push("currency");
    if (evidence.occurredOn !== payment.occurredOn) fields.push("date");
    if (payment.paymentStatus !== "succeeded") fields.push("status");

    if (fields.length === 0) exactMatches.push({ evidenceId: evidence.evidenceId, paymentId: payment.paymentId });
    else mismatches.push({ evidenceId: evidence.evidenceId, paymentId: payment.paymentId, fields });
  }

  return { exactMatches, mismatches, unmatchedEvidence };
}

type EvidenceRow = { id: string; provider_payment_id: string | null; credit_amount: string | null; original_currency: string; occurred_at: string | null };
type LocalPaymentRow = { id: string; provider_transaction_id: string | null; original_amount: string; original_currency: string; occurred_on: string; payment_status: "succeeded" | "failed" | "pending" };

/**
 * Loads one import's sale-kind evidence and the matching local provider
 * payments, reconciles them, and persists only the exact matches (immutable,
 * idempotent via the unique evidence-id constraint). Never called for
 * Payment Tracker imports -- those have no provider transaction ID.
 */
export async function linkB2cProviderEvidenceExactMatches(
  client: DatabaseClient,
  input: { importId: string; provider: "stripe" | "tap" },
): Promise<ProviderEvidenceReconciliationResult> {
  const { data: evidenceRows, error: evidenceError } = await client
    .from("b2c_provider_evidence")
    .select("id,provider_payment_id,credit_amount,original_currency,occurred_at")
    .eq("import_id", input.importId)
    .eq("provider", input.provider)
    .eq("transaction_kind", "sale");
  if (evidenceError) throw new Error(`Could not load ${input.provider} evidence: ${evidenceError.message}`);

  const evidence: ProviderEvidenceRecord[] = ((evidenceRows ?? []) as EvidenceRow[])
    .filter((row): row is EvidenceRow & { provider_payment_id: string; credit_amount: string; occurred_at: string } =>
      Boolean(row.provider_payment_id && row.credit_amount && row.occurred_at))
    .map((row) => ({
      evidenceId: row.id,
      providerTransactionId: row.provider_payment_id,
      amount: String(row.credit_amount),
      currency: row.original_currency,
      occurredOn: row.occurred_at.slice(0, 10),
    }));

  if (evidence.length === 0) return { exactMatches: [], mismatches: [], unmatchedEvidence: [] };

  const transactionIds = [...new Set(evidence.map((row) => row.providerTransactionId))];
  const { data: paymentRows, error: paymentError } = await client
    .from("b2c_payments")
    .select("id,provider_transaction_id,original_amount,original_currency,occurred_on,payment_status")
    .eq("source_system", input.provider)
    .in("provider_transaction_id", transactionIds);
  if (paymentError) throw new Error(`Could not load local ${input.provider} payments: ${paymentError.message}`);

  const payments: LocalProviderPaymentRecord[] = ((paymentRows ?? []) as LocalPaymentRow[])
    .filter((row): row is LocalPaymentRow & { provider_transaction_id: string } => Boolean(row.provider_transaction_id))
    .map((row) => ({
      paymentId: row.id,
      providerTransactionId: row.provider_transaction_id,
      originalAmount: String(row.original_amount),
      originalCurrency: row.original_currency,
      occurredOn: row.occurred_on,
      paymentStatus: row.payment_status,
    }));

  const result = reconcileProviderEvidence({ evidence, payments });

  if (result.exactMatches.length > 0) {
    const { error: linkError } = await client
      .from("b2c_provider_evidence_payment_links")
      .upsert(
        result.exactMatches.map((match) => ({
          provider_evidence_id: match.evidenceId,
          payment_id: match.paymentId,
          match_state: "exact_match" as const,
          matched_during_import_id: input.importId,
        })),
        { onConflict: "provider_evidence_id", ignoreDuplicates: true },
      );
    if (linkError) throw new Error(`Could not record ${input.provider} evidence links: ${linkError.message}`);
  }

  return result;
}
