import type { DatabaseClient } from "@/lib/supabase/server";
import type { ManualRecognisedSaleInput } from "@/lib/validation/financial-contracts";
import type { Database } from "@/types/database.generated";

export type RecognisedSale = Database["public"]["Tables"]["b2b_recognised_sales"]["Row"];
export type PreparedManualRecognisedSaleInput = ManualRecognisedSaleInput & { recognisedAmountUsd: string };

export interface B2bRecognisedSalesRepository {
  createManual(input: PreparedManualRecognisedSaleInput): Promise<RecognisedSale>;
}

/** Data access only. The database trigger assigns the logged-in Admin as entered_by. */
export class SupabaseB2bRecognisedSalesRepository implements B2bRecognisedSalesRepository {
  constructor(private readonly client: DatabaseClient) {}

  async createManual(input: PreparedManualRecognisedSaleInput): Promise<RecognisedSale> {
    const { data, error } = await this.client
      .from("b2b_recognised_sales")
      .insert({
        deal_id: input.dealId,
        booking_id: input.bookingId ?? null,
        recognised_amount: input.recognisedAmount,
        original_currency: input.originalCurrency,
        exchange_rate_to_usd: input.exchangeRateToUsd,
        recognised_amount_usd: input.recognisedAmountUsd,
        recognition_date: input.recognitionDate,
        reporting_period: input.reportingPeriod,
        reason_or_reference: input.reasonOrReference,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Could not record recognised sales: ${error.message}`);
    }
    return data;
  }
}
