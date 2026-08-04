import { z } from "zod";

/** An Admin may close a local review task, never modify the provider source. */
export const b2cReviewResolutionSchema = z.object({
  resolutionStatus: z.enum(["resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3, "Enter a resolution note.").max(1000),
}).strict();

export type B2cReviewResolutionInput = z.infer<typeof b2cReviewResolutionSchema>;

const optionalNonEmpty = (maximum: number) => z.string().trim().min(1).max(maximum).optional();

/** A verified correction overlays one local B2C source record without mutating Stripe data. */
export const b2cPaymentLocalCorrectionSchema = z.object({
  customerName: optionalNonEmpty(200),
  customerEmail: z.string().trim().toLowerCase().email("Enter a valid customer email.").max(320).optional(),
  customerPhone: z.string().trim().regex(/^[0-9+().\-\s]{5,40}$/, "Enter a valid customer mobile number.").optional(),
  categoryCode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens, or underscores.").max(100).optional(),
  membershipTier: optionalNonEmpty(100),
  reason: z.string().trim().min(3, "Enter an audit reason of at least 3 characters.").max(1000),
}).strict().refine((value) => Boolean(value.customerName || value.customerEmail || value.customerPhone || value.categoryCode || value.membershipTier), {
  message: "Enter at least one verified local correction.",
  path: ["customerName"],
});

export type B2cPaymentLocalCorrectionInput = z.infer<typeof b2cPaymentLocalCorrectionSchema>;
