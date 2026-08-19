import { z } from "zod";

const decimalAmount = z.string().trim().regex(/^\d{1,14}(?:\.\d{1,6})?$/, "Enter a valid USD amount with up to 6 decimal places.");

/** Query filters for the safe, paged B2C workspace ledger read. `limit` is capped at 100 rows per page. */
export const b2cWorkspaceLedgerQuerySchema = z.object({
  cursor: z.string().trim().regex(/^\d+$/, "Enter a valid page cursor.").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  period: z.union([z.literal("all"), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Enter a valid reporting month.")]).optional(),
  source: z.enum(["stripe", "tap", "manual_bank_transfer", "finance_tracker"]).optional(),
  sourceStatus: z.enum(["succeeded", "failed", "pending"]).optional(),
  reportingDecision: z.enum(["reportable", "blocked", "excluded", "exception_included"]).optional(),
  issue: z.enum([
    "Possible duplicate", "Unmapped product", "Failed", "Missing customer email",
    "Needs follow-up", "Needs FX review", "Refunded", "Tap statement unmatched",
  ]).optional(),
  currency: z.string().trim().length(3, "Enter a valid 3-letter currency code.").optional(),
  minAmountUsd: decimalAmount.optional(),
  maxAmountUsd: decimalAmount.optional(),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).optional(),
  search: z.string().trim().max(200).optional(),
}).strict();

export type B2cWorkspaceLedgerQuery = z.infer<typeof b2cWorkspaceLedgerQuerySchema>;
