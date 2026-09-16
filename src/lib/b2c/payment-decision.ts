import {
  parseB2cSqlPaymentDecision,
  type B2cBlockingReason,
  type B2cSqlPaymentDecision,
} from "@/lib/b2c/payment-reportability";

export type { B2cBlockingReason };

export type B2cPaymentDecision = {
  sourceStatus: B2cSqlPaymentDecision["sourceStatus"];
  reconciliationStatus: B2cSqlPaymentDecision["reconciliationStatus"];
  reportingDecision: B2cSqlPaymentDecision["reportingDecision"];
  postingStatus: B2cSqlPaymentDecision["postingStatus"];
  blockingReasons: B2cBlockingReason[];
  explanation: string;
};

function explain(
  reportingDecision: B2cPaymentDecision["reportingDecision"],
  blockingReasons: B2cBlockingReason[],
): string {
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
 * Presents the database-authoritative decision. No raw financial facts enter
 * this function, so application code cannot waive or introduce a blocker.
 */
export function presentB2cPaymentDecision(value: unknown): B2cPaymentDecision {
  const decision = parseB2cSqlPaymentDecision(value);
  return {
    sourceStatus: decision.sourceStatus,
    reconciliationStatus: decision.reconciliationStatus,
    reportingDecision: decision.reportingDecision,
    postingStatus: decision.postingStatus,
    blockingReasons: decision.blockingReasons,
    explanation: explain(decision.reportingDecision, decision.blockingReasons),
  };
}
