import { z } from "zod";

/** An Admin may close a local review task, never modify the provider source. */
export const b2cReviewResolutionSchema = z.object({
  resolutionStatus: z.enum(["resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3, "Enter a resolution note.").max(1000),
}).strict();

export type B2cReviewResolutionInput = z.infer<typeof b2cReviewResolutionSchema>;

const optionalNonEmpty = (maximum: number) => z.string().trim().min(1).max(maximum).optional();
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
  customerName: optionalNonEmpty(200),
  customerEmail: z.string().trim().toLowerCase().email("Enter a valid customer email.").max(320).optional(),
  customerPhone: z.string().trim().regex(/^[0-9+().\-\s]{5,40}$/, "Enter a valid customer mobile number.").optional(),
  categoryCode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens, or underscores.").max(100).optional(),
  membershipTier: optionalNonEmpty(100),
  amountUsd: optionalUsdAmount,
  occurredOn: optionalBusinessDate,
  reason: z.string().trim().min(3, "Enter an audit reason of at least 3 characters.").max(1000),
}).strict().refine((value) => Boolean(value.customerName || value.customerEmail || value.customerPhone || value.categoryCode || value.membershipTier || value.amountUsd || value.occurredOn), {
  message: "Enter at least one verified local correction.",
  path: ["customerName"],
});

export type B2cPaymentLocalCorrectionInput = z.infer<typeof b2cPaymentLocalCorrectionSchema>;

/** A controlled exception may count one succeeded source payment without all source metadata. */
export const b2cFinanceExceptionSchema = z.object({
  reason: z.string().trim().min(3, "Enter an exception reason of at least 3 characters.").max(1000),
  confirmedProviderTransaction: z.boolean().refine(Boolean, "Confirm this is the exact Stripe payment ID."),
  confirmedNoKnownDuplicate: z.boolean().refine(Boolean, "Confirm you reviewed this payment for duplicates."),
}).strict();

export type B2cFinanceExceptionInput = z.infer<typeof b2cFinanceExceptionSchema>;
