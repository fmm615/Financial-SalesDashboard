import { z } from "zod";

export const b2cPaymentExclusionReasonSchema = z.enum([
  "not_succeeded",
  "missing_customer_email",
  "possible_duplicate",
  "duplicate_exclusion",
  "needs_follow_up",
  "needs_fx_review",
]);

export type B2cPaymentExclusionReason = z.infer<typeof b2cPaymentExclusionReasonSchema>;

export const b2cBlockingReasonSchema = z.enum([
  "missing_amount",
  "missing_business_date",
  "missing_customer_email",
  "missing_fx",
  "possible_duplicate",
  "duplicate_exclusion",
  "failed_payment",
  "pending_payment",
  "implausible_future_date",
  "other_open_review",
]);

export type B2cBlockingReason = z.infer<typeof b2cBlockingReasonSchema>;

const sqlPaymentDecisionSchema = z.object({
  source_status: z.enum(["succeeded", "failed", "pending"]),
  reconciliation_status: z.enum(["not_required", "duplicate_pending"]),
  reporting_decision: z.enum(["reportable", "blocked", "excluded", "exception_included"]),
  posting_status: z.enum(["not_applicable", "posted"]),
  exclusion_reasons: z.array(b2cPaymentExclusionReasonSchema),
  blocking_reasons: z.array(b2cBlockingReasonSchema),
}).strict().superRefine((decision, context) => {
  // reporting_decision is gated on exclusion_reasons, not blocking_reasons.
  // blocking_reasons is a superset that additionally carries two
  // display-only reasons (a missing/implausible business date) shown on a
  // row without excluding it from totals -- every other blocking reason is
  // a "real" gate that must always co-occur with a matching
  // exclusion_reasons entry. So a reportable/exception_included decision
  // may still carry those two display-only reasons, but never a real one.
  const hasExclusions = decision.exclusion_reasons.length > 0;
  const hasGatingBlockingReason = decision.blocking_reasons.some(
    (reason) => reason !== "missing_business_date" && reason !== "implausible_future_date",
  );
  if (decision.reporting_decision === "reportable" || decision.reporting_decision === "exception_included") {
    if (hasExclusions) context.addIssue({ code: "custom", message: "An included B2C payment cannot have exclusion reasons." });
    if (hasGatingBlockingReason) context.addIssue({ code: "custom", message: "An included B2C payment cannot have a gating blocking reason." });
  }
  if (decision.reporting_decision === "blocked" && !hasExclusions) {
    context.addIssue({ code: "custom", message: "A blocked B2C payment requires an exclusion reason." });
  }
  if (decision.reporting_decision === "excluded" && !decision.blocking_reasons.includes("duplicate_exclusion")) {
    context.addIssue({ code: "custom", message: "An excluded B2C payment requires the audited duplicate exclusion reason." });
  }
});

export type B2cSqlPaymentDecision = {
  sourceStatus: "succeeded" | "failed" | "pending";
  reconciliationStatus: "not_required" | "duplicate_pending";
  reportingDecision: "reportable" | "blocked" | "excluded" | "exception_included";
  postingStatus: "not_applicable" | "posted";
  exclusionReasons: B2cPaymentExclusionReason[];
  blockingReasons: B2cBlockingReason[];
};

/**
 * SQL owns the financial decision. This boundary validates its narrow result
 * before application code may format or display it.
 */
export function parseB2cSqlPaymentDecision(value: unknown): B2cSqlPaymentDecision {
  const parsed = sqlPaymentDecisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid B2C payment decision returned by the database.");
  }
  return {
    sourceStatus: parsed.data.source_status,
    reconciliationStatus: parsed.data.reconciliation_status,
    reportingDecision: parsed.data.reporting_decision,
    postingStatus: parsed.data.posting_status,
    exclusionReasons: parsed.data.exclusion_reasons,
    blockingReasons: parsed.data.blocking_reasons,
  };
}
