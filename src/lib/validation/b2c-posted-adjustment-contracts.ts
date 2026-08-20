import { z } from "zod";

const isPlaceholder = (value: string) => /^(?:-+|—+|n\/?a)$/i.test(value.trim());

const businessDate = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid business date.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "Enter a valid business date.");

const positiveUsdAmount = z.string().trim()
  .regex(/^\d{1,14}(?:\.\d{1,6})?$/, "Enter a valid positive USD amount with up to 6 decimal places.")
  .refine((value) => Number(value) > 0, "Enter a USD amount greater than zero.");

const requiredAuditReason = z.string().trim().min(3, "Enter an audit reason of at least 3 characters.").max(1000)
  .refine((value) => !isPlaceholder(value), "Enter a meaningful audit reason, not a placeholder dash.");

/**
 * The browser only ever sends what it currently believes is true
 * (`expectedOccurredOn`/`expectedAmountUsd`) plus the corrected value it
 * wants. It never computes or signs the actual ledger delta -- the server
 * looks up the posted payment, recomputes the current effective balance, and
 * calls the append-only database RPC, which itself re-validates the expected
 * state before writing anything.
 */
export const b2cPostedFinanceAdjustmentSchema = z.object({
  expectedOccurredOn: businessDate,
  expectedAmountUsd: positiveUsdAmount,
  verifiedOccurredOn: businessDate.optional(),
  verifiedAmountUsd: positiveUsdAmount.optional(),
  reason: requiredAuditReason,
}).strict().refine((value) => Boolean(value.verifiedOccurredOn || value.verifiedAmountUsd), {
  message: "Enter a corrected amount or a corrected reporting date.",
  path: ["verifiedOccurredOn"],
});

export type PostedFinanceAdjustmentRequest = z.infer<typeof b2cPostedFinanceAdjustmentSchema>;
