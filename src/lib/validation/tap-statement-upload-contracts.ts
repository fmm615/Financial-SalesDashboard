import { z } from "zod";

export const TAP_STATEMENT_STORAGE_BUCKET = "b2c-finance-imports";
export const TAP_STATEMENT_MIME_TYPE = "text/csv";

export const tapStatementFinalizeSchema = z.object({
  expectedFileSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export function getSingleTapStatementFile(formData: FormData): File {
  const files = formData.getAll("file");
  const file = files[0];
  if (files.length !== 1 || !file || typeof file !== "object" || !("arrayBuffer" in file) || typeof file.arrayBuffer !== "function" || !("name" in file) || typeof file.name !== "string") {
    throw new Error("Select one Tap statement .csv file.");
  }
  return file as File;
}
