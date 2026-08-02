import type { DatabaseClient } from "@/lib/supabase/server";
import type { ManualBankTransferInput } from "@/lib/validation/financial-contracts";
import type { Database } from "@/types/database.generated";

export type B2cPayment = Database["public"]["Tables"]["b2c_payments"]["Row"];

export interface B2cPaymentsRepository {
  createManualBankTransfer(input: ManualBankTransferInput & { duplicateFingerprint: string }): Promise<B2cPayment>;
}

/** The service supplies the fingerprint; the database enforces source and actor rules. */
export class SupabaseB2cPaymentsRepository implements B2cPaymentsRepository {
  constructor(private readonly client: DatabaseClient) {}

  async createManualBankTransfer(input: ManualBankTransferInput & { duplicateFingerprint: string }): Promise<B2cPayment> {
    const { data, error } = await this.client
      .from("b2c_payments")
      .insert({
        source_system: "manual_bank_transfer",
        provider_transaction_id: input.bankReference ?? null,
        customer_email: input.customerEmail,
        product_mapping_id: input.productMappingId ?? null,
        category_code: input.categoryCode,
        membership_tier: input.membershipTier ?? null,
        payment_status: "succeeded",
        original_amount: input.originalAmount,
        original_currency: input.originalCurrency,
        exchange_rate_to_usd: input.exchangeRateToUsd,
        amount_usd: input.amountUsd,
        gross_amount_usd: input.grossAmountUsd,
        tax_amount_usd: input.taxAmountUsd ?? null,
        net_amount_usd: input.netAmountUsd ?? null,
        occurred_at: input.occurredAt,
        occurred_on: input.occurredOn,
        duplicate_fingerprint: input.duplicateFingerprint,
        manual_entry_reason: input.manualEntryReason,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Could not record manual bank transfer: ${error.message}`);
    }
    return data;
  }
}
