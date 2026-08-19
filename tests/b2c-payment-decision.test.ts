import { describe, expect, it } from "vitest";
import { resolveB2cPaymentDecision, type B2cPaymentDecisionInput } from "@/lib/b2c/payment-decision";

const base: B2cPaymentDecisionInput = {
  sourceSystem: "stripe",
  paymentStatus: "succeeded",
  customerEmail: "member@example.com",
  categoryCode: "membership",
  occurredOn: "2026-08-01",
  openFlagTypes: new Set<string>(),
  amountUsd: "100",
  originalCurrency: "USD",
};

describe("resolveB2cPaymentDecision", () => {
  it("reports a clean succeeded USD mapped payment", () => {
    const decision = resolveB2cPaymentDecision(base);
    expect(decision).toMatchObject({
      sourceStatus: "succeeded",
      reportingDecision: "reportable",
      reconciliationStatus: "not_required",
      postingStatus: "not_applicable",
      blockingReasons: [],
    });
  });

  it("blocks a missing customer email without an audited exception", () => {
    const decision = resolveB2cPaymentDecision({ ...base, customerEmail: null });
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.blockingReasons).toContain("missing_customer_email");
  });

  it("includes a missing-email payment only through an audited Finance exception", () => {
    const decision = resolveB2cPaymentDecision({ ...base, customerEmail: null, hasFinanceException: true });
    expect(decision.reportingDecision).toBe("exception_included");
    expect(decision.blockingReasons).toEqual([]);
  });

  it("blocks a failed payment and keeps its true source status", () => {
    const decision = resolveB2cPaymentDecision({ ...base, paymentStatus: "failed" });
    expect(decision).toMatchObject({ sourceStatus: "failed", reportingDecision: "blocked" });
    expect(decision.blockingReasons).toContain("failed_payment");
  });

  it("blocks a pending payment and keeps its true source status", () => {
    const decision = resolveB2cPaymentDecision({ ...base, paymentStatus: "pending" });
    expect(decision).toMatchObject({ sourceStatus: "pending", reportingDecision: "blocked" });
    expect(decision.blockingReasons).toContain("pending_payment");
  });

  it("blocks a payment with no available business date", () => {
    const decision = resolveB2cPaymentDecision({ ...base, occurredOn: null });
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.blockingReasons).toContain("missing_business_date");
  });

  it("blocks a foreign-currency payment with no approved conversion as missing FX, not a generic missing amount", () => {
    const decision = resolveB2cPaymentDecision({ ...base, originalCurrency: "BHD", amountUsd: null });
    expect(decision.blockingReasons).toContain("missing_fx");
    expect(decision.blockingReasons).not.toContain("missing_amount");
    expect(decision.reportingDecision).toBe("blocked");
  });

  it("allows a foreign-currency payment once its local USD conversion exists", () => {
    const decision = resolveB2cPaymentDecision({ ...base, originalCurrency: "BHD", amountUsd: "132.94" });
    expect(decision.blockingReasons).not.toContain("missing_fx");
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("blocks a USD source with a genuinely missing amount as missing_amount, not missing_fx", () => {
    const decision = resolveB2cPaymentDecision({ ...base, originalCurrency: "USD", amountUsd: null });
    expect(decision.blockingReasons).toContain("missing_amount");
    expect(decision.blockingReasons).not.toContain("missing_fx");
  });

  it("blocks an unresolved possible duplicate and marks reconciliation as duplicate pending", () => {
    const decision = resolveB2cPaymentDecision({ ...base, openFlagTypes: new Set(["possible_duplicate"]) });
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.blockingReasons).toContain("possible_duplicate");
    expect(decision.reconciliationStatus).toBe("duplicate_pending");
  });

  it("excludes a record through an explicit, separately audited manual exclusion", () => {
    const decision = resolveB2cPaymentDecision({ ...base, hasManualExclusion: true });
    expect(decision.reportingDecision).toBe("excluded");
    expect(decision.blockingReasons).toContain("manual_exclusion");
  });

  it("allows a missing email only for immutable approved Finance Tracker provenance", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "finance_tracker", customerEmail: null, isApprovedFinancePayment: true,
      financeLineageStatus: "posted",
    });
    expect(decision.reportingDecision).toBe("reportable");
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.postingStatus).toBe("posted");
  });

  it("keeps a partial refund's payment decision at sourceStatus succeeded -- a refund never replaces the payment decision", () => {
    const decision = resolveB2cPaymentDecision({ ...base, openFlagTypes: new Set(["refunded"]) });
    expect(decision.sourceStatus).toBe("succeeded");
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("blocks unmatched provider evidence without passing statement evidence through the financial gate", () => {
    const decision = resolveB2cPaymentDecision({ ...base, evidenceMatchState: "unmatched" });
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.blockingReasons).toEqual(["unmatched_evidence"]);
    expect(decision.reconciliationStatus).toBe("unmatched");
  });

  it("blocks provider evidence that mismatches the locally recorded values", () => {
    const decision = resolveB2cPaymentDecision({ ...base, evidenceMatchState: "mismatch" });
    expect(decision.blockingReasons).toEqual(["unmatched_evidence"]);
    expect(decision.reconciliationStatus).toBe("mismatch");
  });

  it("marks a matched provider evidence record as reconciled without any blocking reason", () => {
    const decision = resolveB2cPaymentDecision({ ...base, evidenceMatchState: "matched" });
    expect(decision.reconciliationStatus).toBe("matched");
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("represents a Finance Tracker iOS row ready to post", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "finance_tracker", isApprovedFinancePayment: false,
      financeLineageStatus: "ready",
    });
    expect(decision.postingStatus).toBe("ready");
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("represents a Finance Tracker bank-transfer row ready to post", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "finance_tracker", isApprovedFinancePayment: false,
      financeLineageStatus: "ready",
    });
    expect(decision.postingStatus).toBe("ready");
  });

  it("represents a new, clean manual bank transfer as not applicable to posting", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "manual_bank_transfer", financeLineageStatus: "not_applicable",
    });
    expect(decision.postingStatus).toBe("not_applicable");
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("blocks a manual-bank candidate matching an existing tracker lineage as an unresolved duplicate, not a second reportable payment", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "manual_bank_transfer",
      openFlagTypes: new Set(["possible_duplicate"]),
      financeLineageStatus: "not_ready",
    });
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.blockingReasons).toContain("possible_duplicate");
    expect(decision.postingStatus).toBe("not_ready");
  });

  it("marks an ambiguous Finance lineage as a distinct blocking reason and not-ready posting status", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "finance_tracker", financeLineageStatus: "ambiguous",
    });
    expect(decision.blockingReasons).toContain("ambiguous_finance_lineage");
    expect(decision.postingStatus).toBe("not_ready");
    expect(decision.reportingDecision).toBe("blocked");
  });

  it("represents an already-posted Finance payment later corrected as adjusted", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "finance_tracker", isApprovedFinancePayment: true,
      financeLineageStatus: "adjusted",
    });
    expect(decision.postingStatus).toBe("adjusted");
  });

  it("never applies Finance posting status to a Stripe or Tap payment", () => {
    const decision = resolveB2cPaymentDecision({ ...base, sourceSystem: "tap", financeLineageStatus: "ready" });
    expect(decision.postingStatus).toBe("not_applicable");
  });

  it("blocks an unmapped category", () => {
    const decision = resolveB2cPaymentDecision({ ...base, categoryCode: "unmapped" });
    expect(decision.blockingReasons).toContain("unmapped_category");
    expect(decision.reportingDecision).toBe("blocked");
  });

  it("waives the unmapped-category and missing-email rules through an exception, but never a duplicate or failed status", () => {
    const exception = { ...base, customerEmail: null, categoryCode: "unmapped", hasFinanceException: true };
    expect(resolveB2cPaymentDecision(exception).reportingDecision).toBe("exception_included");
    expect(resolveB2cPaymentDecision({ ...exception, openFlagTypes: new Set(["possible_duplicate"]) }).reportingDecision).toBe("blocked");
    expect(resolveB2cPaymentDecision({ ...exception, paymentStatus: "failed" }).reportingDecision).toBe("blocked");
  });
});
