import { z } from "zod";

const decimalPattern = /^\d+(?:\.\d+)?$/;

export const hubSpotDuplicateResolutionSchema = z.object({
  decision: z.enum(["keep_both", "keep_one"]),
  keepDealId: z.string().uuid().nullable().optional(),
  resolutionNote: z.string().trim().min(3, "Enter a decision note.").max(500),
}).superRefine((value, context) => {
  if (value.decision === "keep_one" && !value.keepDealId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["keepDealId"], message: "Select the deal to keep." });
  }
});

const nullableDecimal = z.string().trim().regex(decimalPattern, "Use a non-negative decimal amount.").nullable();
const nullableCurrency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a three-letter currency code.").nullable();
const nullableDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.").nullable();

export const hubSpotDealLocalOverrideSchema = z.object({
  name: z.string().trim().min(1, "Enter a deal name.").max(250),
  ownerName: z.string().trim().max(250).nullable(),
  stageCode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/, "Use an approved stage.").max(80),
  amount: nullableDecimal,
  currency: nullableCurrency,
  exchangeRateToUsd: nullableDecimal,
  closeDate: nullableDate,
  renewalDate: nullableDate,
  reason: z.string().trim().min(3, "Enter an audit reason.").max(500),
}).superRefine((value, context) => {
  const financialValues = [value.amount, value.currency, value.exchangeRateToUsd];
  if (financialValues.some((item) => item === null) && financialValues.some((item) => item !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "Amount, currency, and exchange rate must be entered together." });
  }
  if (value.exchangeRateToUsd !== null && (value.exchangeRateToUsd === "0" || /^0\.0+$/.test(value.exchangeRateToUsd))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["exchangeRateToUsd"], message: "Enter an exchange rate above zero." });
  }
});

export const hubSpotDealExclusionSchema = z.object({
  reason: z.string().trim().min(3, "Enter an exclusion reason.").max(500),
});
