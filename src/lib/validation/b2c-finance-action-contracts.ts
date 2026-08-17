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
