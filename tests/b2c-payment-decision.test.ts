import { describe, expect, it } from "vitest";
import { presentB2cPaymentDecision } from "@/lib/b2c/payment-decision";

function sqlDecision(overrides: Record<string, unknown> = {}) {
  return {
    source_status: "succeeded",
    reconciliation_status: "not_required",
    reporting_decision: "reportable",
    posting_status: "not_applicable",
    exclusion_reasons: [],
    blocking_reasons: [],
    ...overrides,
  };
}

describe("presentB2cPaymentDecision", () => {
  it("uses the SQL-produced reporting decision without raw financial facts", () => {
    expect(presentB2cPaymentDecision(sqlDecision({
      reconciliation_status: "duplicate_pending",
      reporting_decision: "blocked",
      exclusion_reasons: ["possible_duplicate"],
      blocking_reasons: ["possible_duplicate"],
    }))).toEqual({
      sourceStatus: "succeeded",
      reconciliationStatus: "duplicate_pending",
      reportingDecision: "blocked",
      postingStatus: "not_applicable",
      blockingReasons: ["possible_duplicate"],
      explanation: "Blocked by an unresolved possible duplicate.",
    });
  });

  it("presents the exact reportable explanation", () => {
    expect(presentB2cPaymentDecision(sqlDecision()).explanation)
      .toBe("Every approved reporting rule passed, so this record is reportable.");
  });

  it("presents the exact Finance-exception explanation", () => {
    expect(presentB2cPaymentDecision(sqlDecision({ reporting_decision: "exception_included" })).explanation)
      .toBe("Included by an audited Finance exception; every other blocking rule still passed.");
  });

  it("presents the audited duplicate-exclusion explanation", () => {
    expect(presentB2cPaymentDecision(sqlDecision({
      reporting_decision: "excluded",
      exclusion_reasons: ["duplicate_exclusion"],
      blocking_reasons: ["duplicate_exclusion"],
    }))).toMatchObject({
      reportingDecision: "excluded",
      blockingReasons: ["duplicate_exclusion"],
      explanation: "This record is excluded by an audited duplicate exclusion.",
    });
  });

  it("points to the Finance exception when missing customer email is the blocker, since that's the one path that actually resolves it", () => {
    expect(presentB2cPaymentDecision(sqlDecision({
      reporting_decision: "blocked",
      exclusion_reasons: ["missing_customer_email"],
      blocking_reasons: ["missing_customer_email"],
    })).explanation).toBe("Blocked by a missing customer email. An Admin can still include it in Finance through an audited exception below.");
  });

  it("does not add the Finance-exception hint for a blocker the exception can't resolve", () => {
    expect(presentB2cPaymentDecision(sqlDecision({
      reporting_decision: "blocked",
      exclusion_reasons: ["needs_fx_review"],
      blocking_reasons: ["missing_fx"],
    })).explanation).toBe("Blocked by a foreign-currency amount awaiting an approved conversion.");
  });

  it("joins multiple SQL-produced blockers in canonical order", () => {
    expect(presentB2cPaymentDecision(sqlDecision({
      source_status: "failed",
      reporting_decision: "blocked",
      exclusion_reasons: ["needs_fx_review", "not_succeeded", "needs_follow_up"],
      blocking_reasons: ["missing_amount", "failed_payment", "other_open_review"],
    })).explanation).toBe("Blocked by an unavailable USD amount, a payment that did not succeed, an open review item.");
  });

  it("rejects malformed SQL output at the presentation boundary", () => {
    expect(() => presentB2cPaymentDecision(sqlDecision({ reporting_decision: "made_up" })))
      .toThrow(/invalid B2C payment decision/i);
  });
});
