import { z } from "zod";

export const PAYMENT_TRACKER_STORAGE_BUCKET = "b2c-finance-imports";
export const PAYMENT_TRACKER_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const paymentTrackerFinalizeSchema = z.object({
  expectedFileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  supersedesImportId: z.string().uuid().optional(),
}).strict();

export const paymentTrackerPreviewSchema = z.object({
  supersedesImportId: z.string().uuid().optional(),
}).strict();

export function getSinglePaymentTrackerFile(formData: FormData): File {
  const values = formData.getAll("file");
  const file = values[0];
  if (values.length !== 1 || !file || typeof file !== "object" || !("arrayBuffer" in file) || typeof file.arrayBuffer !== "function" || !("name" in file) || typeof file.name !== "string") {
    throw new Error("Select one Payment Tracker .xlsx file.");
  }
  return file as File;
}
