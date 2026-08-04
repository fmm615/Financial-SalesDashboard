import {
  manualRecognisedSaleSchema,
} from "@/lib/validation/financial-contracts";
import { calculateUsdAmount } from "@/lib/financial/usd-calculation";
import type {
  B2bRecognisedSalesRepository,
  RecognisedSale,
} from "@/server/repositories/b2b-recognised-sales-repository";

/**
 * This service intentionally does not derive recognised sales from bookings,
 * invoices, payments, or HubSpot. Finance must enter it explicitly.
 */
export async function recordManualRecognisedSale(
  input: unknown,
  repository: B2bRecognisedSalesRepository,
): Promise<RecognisedSale> {
  const validatedInput = manualRecognisedSaleSchema.parse(input);
  const recognisedAmountUsd = calculateUsdAmount(validatedInput.recognisedAmount, validatedInput.exchangeRateToUsd);
  if (recognisedAmountUsd === null) throw new Error("The recognised amount or USD exchange rate is invalid.");
  return repository.createManual({ ...validatedInput, recognisedAmountUsd });
}
