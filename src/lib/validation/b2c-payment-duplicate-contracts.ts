import { z } from "zod";

const duplicateDecisionReasonSchema = z.string()
  .trim()
  .min(3)
  .max(1000)
  .refine(
    (value) => !/^(?:-+|—+|n\/?a)$/i.test(value),
    "Enter a meaningful duplicate decision reason.",
  );

export const b2cPaymentDuplicateDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("keep_all"),
    canonicalPaymentId: z.null(),
    reason: duplicateDecisionReasonSchema,
  }).strict(),
  z.object({
    decision: z.literal("keep_one"),
    canonicalPaymentId: z.string().uuid(),
    reason: duplicateDecisionReasonSchema,
  }).strict(),
]);

export const b2cPaymentDuplicateStaleDismissalSchema = z.object({
  reason: duplicateDecisionReasonSchema,
}).strict();

export type B2cPaymentDuplicateDecision = z.infer<typeof b2cPaymentDuplicateDecisionSchema>;
export type B2cPaymentDuplicateStaleDismissal = z.infer<typeof b2cPaymentDuplicateStaleDismissalSchema>;
