import { z } from "zod";

/** An Admin may close a local review task, never modify the provider source. */
export const b2cReviewResolutionSchema = z.object({
  resolutionStatus: z.enum(["resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3, "Enter a resolution note.").max(1000),
}).strict();

export type B2cReviewResolutionInput = z.infer<typeof b2cReviewResolutionSchema>;
