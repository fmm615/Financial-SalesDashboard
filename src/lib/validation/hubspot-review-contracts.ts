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
