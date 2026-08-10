import { z } from "zod";

const reviewFlagTypes = ["refunded", "failed", "possible_duplicate", "unmapped_product", "needs_follow_up"] as const;
const reviewFlagStatuses = ["open", "resolved", "dismissed", "all"] as const;
const isPlaceholder = (value: string) => /^(?:-+|—+|n\/?a)$/i.test(value.trim());

export const reviewQueueListQuerySchema = z.object({
  status: z.enum(reviewFlagStatuses).default("open"),
  flagType: z.enum(reviewFlagTypes).optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  query: z.string().trim().max(200).optional(),
}).strict();

export const reviewQueueFlagIdSchema = z.string().uuid();

export const reviewQueueNoteSchema = z.object({
  note: z.string().trim().min(3, "Enter a note of at least 3 characters.").max(1000)
    .refine((value) => !isPlaceholder(value), "Enter a meaningful note, not a placeholder dash."),
}).strict();

export type ReviewQueueListQuery = z.infer<typeof reviewQueueListQuerySchema>;
export type ReviewQueueNoteInput = z.infer<typeof reviewQueueNoteSchema>;
