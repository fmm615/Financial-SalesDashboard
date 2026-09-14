import { b2cPaymentExclusionReasons, type B2cPaymentExclusionReason, type B2cPaymentReportabilityInput } from "@/lib/b2c/payment-reportability";
import { isImplausibleFutureBusinessDate } from "@/lib/b2c/business-date-plausibility";

/**
 * The one accurate B2C decision shape. Every dimension is an independent
 * domain fact: a payment can be `succeeded` yet still `blocked`, or `posted`
 * yet still have an open `duplicate_pending` reconciliation status. Nothing
 * here infers a fact PLAYBOOK does not actually have.
 */
export type B2cPaymentDecision = {
  sourceStatus: "succeeded" | "failed" | "pending";
  reconciliationStatus: "not_required" | "duplicate_pending";
  reportingDecision: "reportable" | "blocked" | "excluded" | "exception_included";
  postingStatus: "not_applicable" | "posted";
  blockingReasons: B2cBlockingReason[];
  explanation: string;
};

export type B2cBlockingReason =
  | "missing_amount"
  | "missing_business_date"
  | "missing_customer_email"
  | "missing_fx"
  | "unmapped_category"
  | "possible_duplicate"
  | "duplicate_exclusion"
  | "failed_payment"
  | "pending_payment"
  | "implausible_future_date"
  | "other_open_review";

/**
 * Everything the shared reportability gate already needs, plus the extra
 * facts that only the decision layer resolves: a real business date and
 * `finance_tracker` posting state.
 */
export type B2cPaymentDecisionInput = Pick<B2cPaymentReportabilityInput, "customerEmail" | "categoryCode" | "openFlagTypes" | "originalCurrency" | "amountUsd" | "hasFinanceException" | "isApprovedFinancePayment" | "hasOpenPaymentDuplicate" | "hasDuplicateExclusion" | "hasBlockingNeedsFollowUp"> & {
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";
  paymentStatus: "succeeded" | "failed" | "pending";
  /** A missing business date is unavailable, never guessed from another field. */
  occurredOn: string | null;
  /** Whether a `finance_tracker` record has been posted. Ignored for `stripe`/`tap`. */
  financeLineageStatus?: "not_applicable" | "posted";
};

function toGateInput(input: B2cPaymentDecisionInput): B2cPaymentReportabilityInput {
  return {
    paymentStatus: input.paymentStatus,
    customerEmail: input.customerEmail,
    categoryCode: input.categoryCode,
    openFlagTypes: input.openFlagTypes,
    originalCurrency: input.originalCurrency,
    amountUsd: input.amountUsd,
    hasFinanceException: input.hasFinanceException,
    isApprovedFinancePayment: input.isApprovedFinancePayment,
    hasOpenPaymentDuplicate: input.hasOpenPaymentDuplicate,
    hasDuplicateExclusion: input.hasDuplicateExclusion,
    hasBlockingNeedsFollowUp: input.hasBlockingNeedsFollowUp,
  };
}

/** Translates one approved gate exclusion into the richer, decision-layer reason vocabulary. */
function translateGateReason(reason: B2cPaymentExclusionReason, input: B2cPaymentDecisionInput): B2cBlockingReason {
  switch (reason) {
    case "not_succeeded":
      return input.paymentStatus === "failed" ? "failed_payment" : "pending_payment";
    case "missing_customer_email":
      return "missing_customer_email";
    case "unmapped_product":
      return "unmapped_category";
    case "possible_duplicate":
      return "possible_duplicate";
    case "duplicate_exclusion":
      return "duplicate_exclusion";
    case "needs_follow_up":
      return "other_open_review";
    case "needs_fx_review":
      return input.originalCurrency && input.originalCurrency !== "USD" ? "missing_fx" : "missing_amount";
  }
}

function resolveReconciliationStatus(input: B2cPaymentDecisionInput): B2cPaymentDecision["reconciliationStatus"] {
  if (input.openFlagTypes.has("possible_duplicate") || input.hasOpenPaymentDuplicate) return "duplicate_pending";
  return "not_required";
}

function resolvePostingStatus(input: B2cPaymentDecisionInput): B2cPaymentDecision["postingStatus"] {
  if (input.sourceSystem === "stripe" || input.sourceSystem === "tap") return "not_applicable";
  return input.financeLineageStatus ?? "not_applicable";
}

function explain(reportingDecision: B2cPaymentDecision["reportingDecision"], blockingReasons: B2cBlockingReason[]): string {
  if (reportingDecision === "excluded") {
    return blockingReasons.includes("duplicate_exclusion")
      ? "This record is excluded by an audited duplicate exclusion."
      : "This record is excluded by an explicit, audited decision.";
  }
  if (blockingReasons.length === 0) {
    return reportingDecision === "exception_included"
      ? "Included by an audited Finance exception; every other blocking rule still passed."
      : "Every approved reporting rule passed, so this record is reportable.";
  }
  const reasonText: Record<B2cBlockingReason, string> = {
    missing_amount: "an unavailable USD amount",
    missing_business_date: "an unavailable business date",
    missing_customer_email: "a missing customer email",
    missing_fx: "a foreign-currency amount awaiting an approved conversion",
    unmapped_category: "an unmapped category",
    possible_duplicate: "an unresolved possible duplicate",
    duplicate_exclusion: "an audited duplicate exclusion",
    failed_payment: "a payment that did not succeed",
    pending_payment: "a payment that has not yet succeeded",
    implausible_future_date: "a business date that has not happened yet",
    other_open_review: "an open review item",
  };
  return `Blocked by ${blockingReasons.map((reason) => reasonText[reason]).join(", ")}.`;
}

/**
 * Builds the one accurate B2C decision from independent domain facts. Every
 * financial inclusion rule flows through the approved `b2cPaymentExclusionReasons`
 * gate first; this function only translates and extends that result, and it
 * never loosens or bypasses a rule the gate already enforces.
 */
export function resolveB2cPaymentDecision(input: B2cPaymentDecisionInput, today = new Date()): B2cPaymentDecision {
  const gateReasons = b2cPaymentExclusionReasons(toGateInput(input));
  const blockingReasons: B2cBlockingReason[] = [];

  if (!input.occurredOn) blockingReasons.push("missing_business_date");
  if (input.occurredOn && isImplausibleFutureBusinessDate(input.occurredOn, today)) blockingReasons.push("implausible_future_date");
  for (const reason of gateReasons) blockingReasons.push(translateGateReason(reason, input));

  const uniqueBlockingReasons = [...new Set(blockingReasons)];

  const reportingDecision: B2cPaymentDecision["reportingDecision"] = input.hasDuplicateExclusion
    ? "excluded"
    : uniqueBlockingReasons.length > 0
      ? "blocked"
      : input.hasFinanceException
        ? "exception_included"
        : "reportable";

  return {
    sourceStatus: input.paymentStatus,
    reconciliationStatus: resolveReconciliationStatus(input),
    reportingDecision,
    postingStatus: resolvePostingStatus(input),
    blockingReasons: uniqueBlockingReasons,
    explanation: explain(reportingDecision, uniqueBlockingReasons),
  };
}
