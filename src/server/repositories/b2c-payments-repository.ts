import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
import { createFinanceSourceIdentity } from "@/lib/b2c/finance-source-identity";
import type { DatabaseClient } from "@/lib/supabase/server";
import { hashPreparedManualBankTransfer, type ManualBankTransferDuplicateAssessment, type PreparedManualBankTransfer } from "@/server/services/record-manual-bank-transfer";
import type { Database } from "@/types/database.generated";

export type B2cPayment = Database["public"]["Tables"]["b2c_payments"]["Row"];

export interface B2cPaymentsRepository {
  /** Read-only, advisory. Never writes; performs no source-record disclosure. */
  assessManualBankTransferDuplicates(input: PreparedManualBankTransfer): Promise<ManualBankTransferDuplicateAssessment>;
  /** The one protected write path: locks/checks the reference, reruns every check, and inserts at most one retained payment atomically. */
  createManualBankTransferAtomically(input: PreparedManualBankTransfer & { expectedInputSha256: string }): Promise<B2cPayment>;
}

function sourceLabelFor(sourceSystem: string): string {
  switch (sourceSystem) {
    case "stripe": return "Stripe";
    case "tap": return "Tap";
    case "finance_tracker": return "Payment Tracker";
    case "manual_bank_transfer": return "Manual bank transfer";
    default: return sourceSystem;
  }
}

const RECONCILIATION_HREF = "/operations/b2c?tab=work&queue=reconciliation";
const recordHref = (paymentId: string) => `/operations/b2c?tab=work&record=${paymentId}`;

/**
 * The database RPC (record_b2c_manual_bank_transfer,
 * supabase/migrations/20260818113000_b2c_manual_bank_transfer_entry.sql) is
 * the sole authority for the write -- it independently rederives every check.
 * This repository's assessment path is advisory only, but it reuses the
 * exact same identity/fingerprint functions the rest of B2C relies on
 * (createFinanceSourceIdentity, createB2cDuplicateFingerprint) so the
 * preview an Admin reviews matches what the RPC will actually enforce.
 */
export class SupabaseB2cPaymentsRepository implements B2cPaymentsRepository {
  constructor(private readonly client: DatabaseClient) {}

  async assessManualBankTransferDuplicates(input: PreparedManualBankTransfer): Promise<ManualBankTransferDuplicateAssessment> {
    const inputSha256 = hashPreparedManualBankTransfer(input);

    const { data: exactReference, error: exactReferenceError } = await this.client
      .from("b2c_payments")
      .select("id")
      .eq("source_system", "manual_bank_transfer")
      .eq("provider_transaction_id", input.bankReference)
      .maybeSingle();
    if (exactReferenceError) throw new Error(`Could not check the bank reference: ${exactReferenceError.message}`);
    if (exactReference) {
      return { inputSha256, matchState: "exact_existing", exactMatchReason: "bank_reference", exactMatchHref: recordHref(exactReference.id), possibleMatches: [] };
    }

    const financeIdentity = createFinanceSourceIdentity({
      normalizedCustomerName: input.customerName,
      occurredOn: input.occurredOn,
      amountUsd: input.amountUsd,
      normalizedPaymentMethod: "bank transfer",
    });

    const { data: lineage, error: lineageError } = await this.client
      .from("b2c_finance_record_lineages")
      .select("id,represented_payment_id")
      .eq("source_identity", financeIdentity)
      .maybeSingle();
    if (lineageError) throw new Error(`Could not check the Payment Tracker lineage: ${lineageError.message}`);
    if (lineage) {
      let paymentId: string | null = lineage.represented_payment_id;
      if (!paymentId) {
        const { data: post } = await this.client.from("b2c_finance_ledger_posts").select("payment_id").eq("lineage_id", lineage.id).maybeSingle();
        paymentId = post?.payment_id ?? null;
      }
      return {
        inputSha256,
        matchState: "exact_existing",
        exactMatchReason: "finance_lineage",
        exactMatchHref: paymentId ? recordHref(paymentId) : RECONCILIATION_HREF,
        possibleMatches: [],
      };
    }

    const { data: candidates, error: candidatesError } = await this.client
      .from("b2c_finance_import_version_candidates")
      .select("id")
      .eq("source_identity", financeIdentity);
    if (candidatesError) throw new Error(`Could not check the Payment Tracker import candidates: ${candidatesError.message}`);
    if (candidates && candidates.length > 0) {
      const candidateIds = candidates.map((row) => row.id);
      const { data: decisions, error: decisionsError } = await this.client
        .from("b2c_finance_import_version_decisions")
        .select("candidate_id")
        .in("candidate_id", candidateIds);
      if (decisionsError) throw new Error(`Could not check the Payment Tracker import decisions: ${decisionsError.message}`);
      const decided = new Set((decisions ?? []).map((row) => row.candidate_id));
      if (candidateIds.some((id) => !decided.has(id))) {
        return { inputSha256, matchState: "exact_existing", exactMatchReason: "finance_lineage", exactMatchHref: RECONCILIATION_HREF, possibleMatches: [] };
      }
    }

    const duplicateFingerprint = createB2cDuplicateFingerprint({
      customerEmail: input.customerEmail,
      amountUsd: input.amountUsd,
      originalCurrency: "USD",
      categoryCode: input.categoryCode,
      occurredOn: input.occurredOn,
      providerTransactionId: input.bankReference,
    });
    const receivedAt = new Date(input.receivedAtRaw);
    const windowStart = new Date(receivedAt.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(receivedAt.getTime() + 48 * 60 * 60 * 1000).toISOString();

    const { data: possible, error: possibleError } = await this.client
      .from("b2c_payments")
      .select("id,source_system,occurred_on,amount_usd")
      .eq("payment_status", "succeeded")
      .eq("duplicate_fingerprint", duplicateFingerprint)
      .gte("occurred_at", windowStart)
      .lte("occurred_at", windowEnd);
    if (possibleError) throw new Error(`Could not check for recent B2C content duplicates: ${possibleError.message}`);
    if (possible && possible.length > 0) {
      return {
        inputSha256,
        matchState: "possible_duplicate",
        exactMatchReason: null,
        exactMatchHref: null,
        possibleMatches: possible.map((row) => ({
          recordKind: row.source_system === "finance_tracker" ? "finance_row" : "provider_payment",
          recordId: row.id,
          sourceLabel: sourceLabelFor(row.source_system),
          occurredOn: row.occurred_on,
          amountUsd: String(row.amount_usd),
        })),
      };
    }

    return { inputSha256, matchState: "clear", exactMatchReason: null, exactMatchHref: null, possibleMatches: [] };
  }

  async createManualBankTransferAtomically(input: PreparedManualBankTransfer & { expectedInputSha256: string }): Promise<B2cPayment> {
    const { data, error } = await this.client.rpc("record_b2c_manual_bank_transfer", {
      p_bank_reference: input.bankReference,
      p_customer_email: input.customerEmail,
      p_customer_name: input.customerName,
      p_category_code: input.categoryCode,
      p_membership_tier: input.membershipTier,
      p_amount_usd_text: input.amountUsd,
      p_received_at_raw: input.receivedAtRaw,
      p_reason: input.reason,
      p_expected_input_sha256: input.expectedInputSha256,
    });
    if (error || !data) {
      throw new Error("Could not record the manual bank transfer. No B2C data was changed.");
    }
    return data;
  }
}
