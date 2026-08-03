import { z } from "zod";

const decimalPattern = /^\d+(?:\.\d+)?$/;

const decimal = z.string().trim().regex(decimalPattern, "Enter a non-negative decimal amount.");
const positiveDecimal = decimal.refine((value) => value !== "0" && !/^0\.0+$/.test(value), "Enter an exchange rate above zero.");

export const hubSpotDealCorrectionSchema = z.object({
  amount: decimal,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a three-letter currency code."),
  exchangeRateToUsd: positiveDecimal,
  reason: z.string().trim().min(3, "Enter a correction reason.").max(500),
});

export const hubSpotErrorResolutionSchema = z.object({
  resolutionNote: z.string().trim().min(3, "Enter a resolution note.").max(500),
});

export const hubSpotDuplicateResolutionSchema = z.object({
  decision: z.enum(["keep_both", "keep_one"]),
  keepDealId: z.string().uuid().nullable().optional(),
  resolutionNote: z.string().trim().min(3, "Enter a decision note.").max(500),
}).superRefine((value, context) => {
  if (value.decision === "keep_one" && !value.keepDealId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keepDealId"], message: "Select the deal to keep." });
  }
});

export const hubSpotCloseDateCorrectionSchema = z.object({
  closeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid close date."),
  reason: z.string().trim().min(3, "Enter a correction reason.").max(500),
});
