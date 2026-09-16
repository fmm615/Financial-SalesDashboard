import { z } from "zod";

/**
 * Bounds for the Admin-configurable B2C duplicate-detection window. Mirrored
 * exactly by the database check constraint on
 * public.b2c_settings.duplicate_detection_window_hours and by the
 * update_b2c_duplicate_detection_window RPC
 * (supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql):
 * - minimum 1 hour: a zero or negative window would compare nothing.
 * - maximum 168 hours (7 days): beyond about a week, matching purely by
 *   content (effective email + USD amount + business date) starts
 *   conflating unrelated repeat purchases instead of catching accidental
 *   double-entry/double-charge duplicates.
 */
export const B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS = 1;
export const B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS = 168;

export const b2cDuplicateDetectionWindowSchema = z.object({
  windowHours: z
    .number()
    .int()
    .min(B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS)
    .max(B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export type B2cDuplicateDetectionWindowInput = z.infer<typeof b2cDuplicateDetectionWindowSchema>;
