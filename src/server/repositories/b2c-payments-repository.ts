import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
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

const recordHref = (paymentId: string) => `/operations/b2c?tab=work&record=${paymentId}`;

/**
 * Historical default and fallback for the configurable duplicate-detection
 * window (public.b2c_settings.duplicate_detection_window_hours). Used only if
 * the settings row is somehow missing or unreadable; the row is bootstrapped
 * by supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql and
 * is never deleted, so this should not normally be reached.
 */
const DEFAULT_DUPLICATE_DETECTION_WINDOW_HOURS = 48;

/**
 * The database RPC (record_b2c_manual_bank_transfer,
 * supabase/migrations/20270101000500_remove_b2c_category.sql) is the sole
 * authority for the write -- it independently rederives every check. This repository's
 * assessment path is advisory only, but it reuses the exact same fingerprint
 * function the rest of B2C relies on (createB2cDuplicateFingerprint) so the
 * preview an Admin reviews matches what the RPC will actually enforce.
 */
export class SupabaseB2cPaymentsRepository implements B2cPaymentsRepository {
  constructor(private readonly client: DatabaseClient) {}

  /**
   * Reads the Admin-configurable duplicate-detection window (see
   * public.b2c_settings, supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql)
   * so the preview an Admin reviews always matches the window the ledger's
   * own possible-duplicate flagging (public.open_b2c_payment_duplicate_group)
   * is currently enforcing. Falls back to the historical 48-hour default only
   * if the settings row is unreadable.
   */
  private async getDuplicateDetectionWindowHours(): Promise<number> {
    const { data, error } = await this.client
      .from("b2c_settings")
      .select("duplicate_detection_window_hours")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return DEFAULT_DUPLICATE_DETECTION_WINDOW_HOURS;
    return data.duplicate_detection_window_hours;
  }

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

    const duplicateFingerprint = createB2cDuplicateFingerprint({
      customerEmail: input.customerEmail,
      amountUsd: input.amountUsd,
      originalCurrency: "USD",
      occurredOn: input.occurredOn,
      providerTransactionId: input.bankReference,
    });
    const windowHours = await this.getDuplicateDetectionWindowHours();
    const receivedAt = new Date(input.receivedAtRaw);
    const windowStart = new Date(receivedAt.getTime() - windowHours * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(receivedAt.getTime() + windowHours * 60 * 60 * 1000).toISOString();

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
