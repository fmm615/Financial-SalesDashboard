import { z } from "zod";

export const STRIPE_CHARGES_STORAGE_BUCKET = "b2c-finance-imports";
export const STRIPE_CHARGES_MIME_TYPE = "text/csv";

export const stripeChargesFinalizeSchema = z.object({
  expectedFileSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export function getSingleStripeChargesFile(formData: FormData): File {
  const files = formData.getAll("file");
  const file = files[0];
  if (files.length !== 1 || !file || typeof file !== "object" || !("arrayBuffer" in file) || typeof file.arrayBuffer !== "function" || !("name" in file) || typeof file.name !== "string") {
    throw new Error("Select one Stripe Charges .csv file.");
  }
  return file as File;
}
