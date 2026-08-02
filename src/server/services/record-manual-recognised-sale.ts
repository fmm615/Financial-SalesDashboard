import {
  manualRecognisedSaleSchema,
  type ManualRecognisedSaleInput,
} from "@/lib/validation/financial-contracts";
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
  const validatedInput: ManualRecognisedSaleInput = manualRecognisedSaleSchema.parse(input);
  return repository.createManual(validatedInput);
}
