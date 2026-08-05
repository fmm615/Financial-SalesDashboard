import { z } from "zod";

/** An Admin may close a local review task, never modify the provider source. */
export const b2cReviewResolutionSchema = z.object({
  resolutionStatus: z.enum(["resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3, "Enter a resolution note.").max(1000),
}).strict();

export type B2cReviewResolutionInput = z.infer<typeof b2cReviewResolutionSchema>;

const isPlaceholder = (value: string) => /^(?:-+|—+|n\/?a)$/i.test(value.trim());
const optionalVerifiedText = (maximum: number, field: string) => z.string().trim().min(1).max(maximum)
  .refine((value) => !isPlaceholder(value), `${field} cannot be a placeholder dash.`)
  .optional();
const requiredAuditReason = z.string().trim().min(3, "Enter an audit reason of at least 3 characters.").max(1000)
  .refine((value) => !isPlaceholder(value), "Enter a meaningful audit reason, not a placeholder dash.");
const optionalUsdAmount = z.string().trim()
  .regex(/^\d{1,14}(?:\.\d{1,6})?$/, "Enter a valid positive USD amount with up to 6 decimal places.")
  .refine((value) => Number(value) > 0, "Enter a USD amount greater than zero.")
  .optional();
const optionalBusinessDate = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid business date.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "Enter a valid business date.")
  .optional();

/** A verified correction overlays one local B2C source record without mutating Stripe data. */
export const b2cPaymentLocalCorrectionSchema = z.object({
  customerName: optionalVerifiedText(200, "Customer name"),
  customerEmail: z.string().trim().toLowerCase().email("Enter a valid customer email.").max(320).optional(),
  customerPhone: z.string().trim().regex(/^[0-9+().\-\s]{5,40}$/, "Enter a valid customer mobile number.").refine((value) => !isPlaceholder(value), "Customer mobile cannot be a placeholder dash.").optional(),
  categoryCode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens, or underscores.").max(100).refine((value) => value !== "unmapped", "Enter a verified PLAYBOOK category, not unmapped.").optional(),
  membershipTier: optionalVerifiedText(100, "Plan or tier"),
  amountUsd: optionalUsdAmount,
  occurredOn: optionalBusinessDate,
  reason: requiredAuditReason,
}).strict().refine((value) => Boolean(value.customerName || value.customerEmail || value.customerPhone || value.categoryCode || value.membershipTier || value.amountUsd || value.occurredOn), {
  message: "Enter at least one verified local correction.",
  path: ["customerName"],
});

export type B2cPaymentLocalCorrectionInput = z.infer<typeof b2cPaymentLocalCorrectionSchema>;

/** A controlled exception may count one succeeded source payment without all source metadata. */
export const b2cFinanceExceptionSchema = z.object({
  reason: requiredAuditReason,
  confirmedProviderTransaction: z.boolean().refine(Boolean, "Confirm this is the exact Stripe payment ID."),
  confirmedNoKnownDuplicate: z.boolean().refine(Boolean, "Confirm you reviewed this payment for duplicates."),
}).strict();

export type B2cFinanceExceptionInput = z.infer<typeof b2cFinanceExceptionSchema>;
