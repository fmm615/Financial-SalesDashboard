import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const nonNegativeMoney = z.string().regex(/^\d+(?:\.\d{1,6})?$/, "Use a non-negative decimal with up to 6 places.");
const nonEmpty = z.string().trim().min(1);

const targetStatusSchema = z.enum(["draft", "active"]);

export const financialMetricCodeSchema = z.enum([
  "b2c_cash_received",
  "b2b_bookings",
  "b2b_recognised_sales",
  "total_recognised_sales",
]);

export const financialTargetSchema = z.object({
  metricCode: financialMetricCodeSchema,
  periodStart: isoDate,
  periodEnd: isoDate,
  targetAmountUsd: nonNegativeMoney,
  status: targetStatusSchema,
  financeReference: nonEmpty.max(1000),
  revisionReason: nonEmpty.max(1000),
}).strict().refine((value) => value.periodEnd >= value.periodStart, {
  path: ["periodEnd"],
  message: "The end date cannot be before the start date.",
});

export const operationalTargetSchema = z.object({
  displayName: nonEmpty.max(160),
  valueKind: z.enum(["money_usd", "quantity"]),
  targetValue: nonNegativeMoney,
  unitLabel: z.string().trim().min(1).max(80).optional(),
  periodStart: isoDate,
  periodEnd: isoDate,
  status: targetStatusSchema,
  financeReference: nonEmpty.max(1000),
  revisionReason: nonEmpty.max(1000),
}).strict().superRefine((value, context) => {
  if (value.valueKind === "quantity" && !value.unitLabel) {
    context.addIssue({ code: "custom", path: ["unitLabel"], message: "Quantity targets require a unit." });
  }
  if (value.valueKind === "money_usd" && value.unitLabel) {
    context.addIssue({ code: "custom", path: ["unitLabel"], message: "Money targets use USD and do not accept a unit." });
  }
  if (value.periodEnd < value.periodStart) {
    context.addIssue({ code: "custom", path: ["periodEnd"], message: "The end date cannot be before the start date." });
  }
});

export const operationalProgressSchema = z.object({
  targetId: uuid,
  actualValue: nonNegativeMoney,
  effectiveOn: isoDate,
  evidenceNote: nonEmpty.max(1000),
}).strict();

export type FinancialTargetInput = z.infer<typeof financialTargetSchema>;
export type OperationalTargetInput = z.infer<typeof operationalTargetSchema>;
export type OperationalProgressInput = z.infer<typeof operationalProgressSchema>;

