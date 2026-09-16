import { describe, expect, it } from "vitest";
import { parseB2cSqlPaymentDecision } from "@/lib/b2c/payment-reportability";

const completeSqlDecision = {
  source_status: "succeeded",
  reconciliation_status: "not_required",
  reporting_decision: "reportable",
  posting_status: "not_applicable",
  exclusion_reasons: [],
  blocking_reasons: [],
};

describe("B2C SQL payment decision validation", () => {
  it("maps the complete database decision contract to typed application fields", () => {
    expect(parseB2cSqlPaymentDecision(completeSqlDecision)).toEqual({
      sourceStatus: "succeeded",
      reconciliationStatus: "not_required",
      reportingDecision: "reportable",
      postingStatus: "not_applicable",
      exclusionReasons: [],
      blockingReasons: [],
    });
  });

  it("accepts every canonical ordered reason emitted by PostgreSQL", () => {
    expect(parseB2cSqlPaymentDecision({
      ...completeSqlDecision,
      reconciliation_status: "duplicate_pending",
      reporting_decision: "excluded",
      exclusion_reasons: ["needs_fx_review", "not_succeeded", "missing_customer_email", "possible_duplicate", "duplicate_exclusion", "needs_follow_up"],
      blocking_reasons: ["missing_business_date", "implausible_future_date", "missing_fx", "failed_payment", "missing_customer_email", "possible_duplicate", "duplicate_exclusion", "other_open_review"],
    })).toMatchObject({
      reportingDecision: "excluded",
      blockingReasons: ["missing_business_date", "implausible_future_date", "missing_fx", "failed_payment", "missing_customer_email", "possible_duplicate", "duplicate_exclusion", "other_open_review"],
    });
  });

  it("rejects an unknown database reason instead of guessing its meaning", () => {
    expect(() => parseB2cSqlPaymentDecision({
      ...completeSqlDecision, reporting_decision: "blocked", blocking_reasons: ["invented_reason"],
    })).toThrow(/invalid B2C payment decision/i);
  });

  it("accepts a reportable decision that carries only the display-only future-date blocking reason", () => {
    expect(parseB2cSqlPaymentDecision({
      ...completeSqlDecision, blocking_reasons: ["implausible_future_date"],
    })).toMatchObject({ reportingDecision: "reportable", blockingReasons: ["implausible_future_date"] });
  });

  it("rejects a reportable database decision that also claims a gating blocker", () => {
    expect(() => parseB2cSqlPaymentDecision({
      ...completeSqlDecision, blocking_reasons: ["possible_duplicate"],
    })).toThrow(/invalid B2C payment decision/i);
  });

  it("rejects a blocked database decision with no blocking reason", () => {
    expect(() => parseB2cSqlPaymentDecision({
      ...completeSqlDecision, reporting_decision: "blocked",
    })).toThrow(/invalid B2C payment decision/i);
  });
});
