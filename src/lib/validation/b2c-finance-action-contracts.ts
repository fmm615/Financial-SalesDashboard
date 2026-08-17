import { z } from "zod";

const decisionReason = z.string().trim().min(3, "Enter a reason between 3 and 1000 characters.").max(1000, "Enter a reason between 3 and 1000 characters.");

/** One auditable decision is written for each selected exact B2C/B2C Cons pair. */
export const b2cFinanceBulkCanonicalDecisionSchema = z.object({
  groupIds: z.array(z.string().uuid("Select valid B2C Finance duplicate groups.")).min(1, "Select at least one duplicate group.").max(200, "Select no more than 200 duplicate groups at once.")
    .refine((groupIds) => new Set(groupIds).size === groupIds.length, "Select each duplicate group only once."),
  sourceTab: z.enum(["B2C", "B2C Cons"]),
  reason: decisionReason,
}).strict();

export type B2cFinanceBulkCanonicalDecisionInput = z.infer<typeof b2cFinanceBulkCanonicalDecisionSchema>;

export const b2cFinanceDateAuthoritySchema = z.object({
  financeRowIds: z.array(z.string().uuid("Select valid B2C Finance rows.")).min(1, "Select at least one Finance row.").max(200, "Select no more than 200 Finance rows at once.")
    .refine((rowIds) => new Set(rowIds).size === rowIds.length, "Select each Finance row only once."),
  reason: decisionReason,
}).strict();

const optionalVerifiedText = (maximum: number, label: string) => z.string().trim().min(1, `Enter a ${label}.`).max(maximum, `${label} is too long.`).optional();

/** Corrections are verified overlays; empty values do not erase workbook evidence. */
export const b2cFinanceRowCorrectionSchema = z.object({
  occurredOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid Finance date.")
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "Enter a valid Finance date.").optional(),
  amountUsd: z.string().trim().regex(/^\d{1,14}(?:\.\d{1,6})?$/, "Enter a valid positive USD amount with up to 6 decimal places.")
    .refine((value) => Number(value) > 0, "Enter a USD amount greater than zero.").optional(),
  customerName: optionalVerifiedText(200, "verified customer name"),
  category: optionalVerifiedText(200, "verified category"),
  reason: decisionReason,
}).strict().refine((value) => Boolean(value.occurredOn || value.amountUsd || value.customerName || value.category), {
  message: "Enter at least one verified Finance correction.",
  path: ["customerName"],
});

export type B2cFinanceDateAuthorityInput = z.infer<typeof b2cFinanceDateAuthoritySchema>;
export type B2cFinanceRowCorrectionInput = z.infer<typeof b2cFinanceRowCorrectionSchema>;
