import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Use an ISO 4217 uppercase currency code.");
const money = z.string().regex(/^\d+(?:\.\d{1,6})?$/, "Use a positive decimal with up to 6 places.");
const nonNegativeMoney = z.string().regex(/^\d+(?:\.\d{1,6})?$/, "Use a non-negative decimal with up to 6 places.");
const exchangeRate = z.string().regex(/^\d+(?:\.\d{1,10})?$/, "Use an exchange rate with up to 10 places.");
const nonEmpty = z.string().trim().min(1);

/** Browser and API boundaries use decimal strings so JavaScript never rounds money. */
export const manualBankTransferSchema = z.object({
  customerEmail: z.string().trim().toLowerCase().email(),
  customerName: z.string().trim().min(1).max(200).optional(),
  categoryCode: nonEmpty.max(100),
  membershipTier: z.string().trim().min(1).max(100).optional(),
  productMappingId: uuid.optional(),
  originalAmount: money,
  originalCurrency: currencyCode,
  exchangeRateToUsd: exchangeRate,
  amountUsd: money,
  grossAmountUsd: money,
  taxAmountUsd: nonNegativeMoney.optional(),
  netAmountUsd: nonNegativeMoney.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  occurredOn: isoDate,
  bankReference: nonEmpty.max(200).optional(),
  manualEntryReason: nonEmpty.max(1000),
}).strict().superRefine((value, context) => {
  if ((value.taxAmountUsd === undefined) !== (value.netAmountUsd === undefined)) {
    context.addIssue({ code: "custom", path: ["taxAmountUsd"], message: "Provide tax and net together, or leave both unknown." });
  }
});

export const financialCorrectionSchema = z.object({
  targetArea: z.enum(["b2c_payment", "b2b_booking", "b2b_recognised_sale", "expense"]),
  targetRecordId: uuid,
  correctionType: z.enum(["amount", "date", "category", "classification", "other"]),
  beforeValue: z.record(z.string(), z.unknown()),
  afterValue: z.record(z.string(), z.unknown()),
  reason: nonEmpty.max(1000),
  effectiveOn: isoDate,
}).strict().refine((value) => JSON.stringify(value.beforeValue) !== JSON.stringify(value.afterValue), {
  message: "A correction must change a value.",
  path: ["afterValue"],
});

export const productMappingSchema = z.object({
  sourceSystem: z.enum(["stripe", "tap"]),
  externalProductId: nonEmpty.max(255),
  productId: uuid,
  categoryCode: nonEmpty.max(100),
  membershipTier: z.string().trim().min(1).max(100).optional(),
}).strict();

export const financialTargetSchema = z.object({
  metricCode: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  periodStart: isoDate,
  periodEnd: isoDate,
  targetAmountUsd: nonNegativeMoney,
  notes: z.string().trim().max(1000).optional(),
}).strict().refine((value) => value.periodEnd >= value.periodStart, {
  message: "The end date cannot be before the start date.",
  path: ["periodEnd"],
});

export const summitUpdateSchema = z.object({
  metricCode: z.enum(["tickets", "sponsors", "booths", "revenue", "costs"]),
  updateDate: isoDate,
  value: nonNegativeMoney,
  originalCurrency: currencyCode.optional(),
  exchangeRateToUsd: exchangeRate.optional(),
  valueUsd: nonNegativeMoney.optional(),
  reasonOrReference: nonEmpty.max(1000),
}).strict().superRefine((value, context) => {
  const isMoneyMetric = value.metricCode === "revenue" || value.metricCode === "costs";
  const fields = [value.originalCurrency, value.exchangeRateToUsd, value.valueUsd];
  if (isMoneyMetric && fields.some((field) => field === undefined)) {
    context.addIssue({ code: "custom", message: "Revenue and costs require currency, exchange rate, and USD value." });
  }
  if (!isMoneyMetric && fields.some((field) => field !== undefined)) {
    context.addIssue({ code: "custom", message: "Count metrics do not accept currency fields." });
  }
});

export const reviewResolutionSchema = z.object({
  flagId: uuid,
  resolutionStatus: z.enum(["resolved", "dismissed"]),
  resolutionNote: nonEmpty.max(2000),
}).strict();

export const reportRequestSchema = z.object({
  reportType: z.enum(["monthly", "quarterly", "annual", "ad_hoc"]),
  periodStart: isoDate,
  periodEnd: isoDate,
  deliveryRequested: z.boolean().default(false),
}).strict().refine((value) => value.periodEnd >= value.periodStart, {
  message: "The end date cannot be before the start date.",
  path: ["periodEnd"],
});

export const manualB2bDealSchema = z.object({
  companyName: nonEmpty.max(250),
  name: nonEmpty.max(255),
  stageCode: z.enum(["discovery", "qualified", "proposal", "negotiation", "closed_won", "closed_lost"]),
  pipelineOriginalAmount: nonNegativeMoney,
  originalCurrency: currencyCode,
  exchangeRateToUsd: exchangeRate,
  closeDate: isoDate.nullable(),
  renewalDate: isoDate.nullable(),
  ownerName: z.string().trim().max(200).nullable(),
  manualEntryReason: nonEmpty.max(1000),
}).strict().superRefine((value, context) => {
  if (value.stageCode === "closed_won" && !value.closeDate) {
    context.addIssue({ code: "custom", path: ["closeDate"], message: "Closed-won deals require a close date so their booking can be recorded separately." });
  }
});

export const manualRecognisedSaleSchema = z.object({
  dealId: uuid,
  bookingId: uuid.optional(),
  recognisedAmount: nonNegativeMoney,
  originalCurrency: currencyCode,
  exchangeRateToUsd: exchangeRate,
  recognisedAmountUsd: nonNegativeMoney,
  recognitionDate: isoDate,
  reportingPeriod: isoDate,
  reasonOrReference: nonEmpty.max(1000),
}).strict().refine((value) => value.reportingPeriod.endsWith("-01"), {
  message: "The reporting period must be the first day of its month.",
  path: ["reportingPeriod"],
});

export type ManualBankTransferInput = z.infer<typeof manualBankTransferSchema>;
export type FinancialCorrectionInput = z.infer<typeof financialCorrectionSchema>;
export type ProductMappingInput = z.infer<typeof productMappingSchema>;
export type FinancialTargetInput = z.infer<typeof financialTargetSchema>;
export type SummitUpdateInput = z.infer<typeof summitUpdateSchema>;
export type ReviewResolutionInput = z.infer<typeof reviewResolutionSchema>;
export type ReportRequestInput = z.infer<typeof reportRequestSchema>;
export type ManualB2bDealInput = z.infer<typeof manualB2bDealSchema>;
export type ManualRecognisedSaleInput = z.infer<typeof manualRecognisedSaleSchema>;
