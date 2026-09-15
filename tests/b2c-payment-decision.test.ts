import { describe, expect, it } from "vitest";
import { resolveB2cPaymentDecision, type B2cPaymentDecisionInput } from "@/lib/b2c/payment-decision";

const base: B2cPaymentDecisionInput = {
  sourceSystem: "stripe",
  paymentStatus: "succeeded",
  customerEmail: "member@example.com",
  occurredOn: "2026-08-01",
  openFlagTypes: new Set<string>(),
  amountUsd: "100",
  originalCurrency: "USD",
};

describe("resolveB2cPaymentDecision", () => {
  it("reports a clean succeeded USD provider payment", () => {
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

  it("keeps an open payment duplicate group blocked independently of raw review-flag translation", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, openFlagTypes: new Set(), hasOpenPaymentDuplicate: true,
    });

    expect(decision).toMatchObject({
      reconciliationStatus: "duplicate_pending",
      reportingDecision: "blocked",
    });
    expect(decision.blockingReasons).toContain("possible_duplicate");
  });

  it("keeps an explicitly excluded duplicate outside reporting after its flag closes", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, openFlagTypes: new Set(), hasDuplicateExclusion: true,
    });

    expect(decision.reportingDecision).toBe("excluded");
    expect(decision.blockingReasons).toContain("duplicate_exclusion");
    expect(decision.explanation).toContain("an audited duplicate exclusion");
  });

  it("keeps a prior duplicate exclusion excluded when a later group inclusion leaves no open duplicate", () => {
    const decision = resolveB2cPaymentDecision({
      ...base,
      openFlagTypes: new Set(),
      hasOpenPaymentDuplicate: false,
      hasDuplicateExclusion: true,
    });

    expect(decision.reportingDecision).toBe("excluded");
    expect(decision.blockingReasons).toEqual(["duplicate_exclusion"]);
  });

  it("blocks a payment whose business date has not happened yet, even when it is already posted", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "finance_tracker", occurredOn: "2026-11-01", isApprovedFinancePayment: true,
      financeLineageStatus: "posted",
    }, new Date("2026-08-20T00:00:00.000Z"));

    expect(decision.blockingReasons).toContain("implausible_future_date");
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.postingStatus).toBe("posted");
  });

  it("never lets a Finance exception waive an implausible future date", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, occurredOn: "2026-11-01", hasFinanceException: true,
    }, new Date("2026-08-20T00:00:00.000Z"));

    expect(decision.blockingReasons).toContain("implausible_future_date");
    expect(decision.reportingDecision).toBe("blocked");
  });

  it("allows a business date up to one day ahead of today", () => {
    const decision = resolveB2cPaymentDecision({ ...base, occurredOn: "2026-08-21" }, new Date("2026-08-20T00:00:00.000Z"));

    expect(decision.blockingReasons).not.toContain("implausible_future_date");
    expect(decision.reportingDecision).toBe("reportable");
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

  it("represents a new, clean manual bank transfer as not applicable to posting", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "manual_bank_transfer", financeLineageStatus: "not_applicable",
    });
    expect(decision.postingStatus).toBe("not_applicable");
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("blocks a manual-bank candidate with an open possible duplicate, not a second reportable payment", () => {
    const decision = resolveB2cPaymentDecision({
      ...base, sourceSystem: "manual_bank_transfer",
      openFlagTypes: new Set(["possible_duplicate"]),
      financeLineageStatus: "not_applicable",
    });
    expect(decision.reportingDecision).toBe("blocked");
    expect(decision.blockingReasons).toContain("possible_duplicate");
    expect(decision.postingStatus).toBe("not_applicable");
  });

  it("never applies Finance posting status to a Stripe or Tap payment", () => {
    const decision = resolveB2cPaymentDecision({ ...base, sourceSystem: "tap", financeLineageStatus: "posted" });
    expect(decision.postingStatus).toBe("not_applicable");
  });

  it("keeps a provider payment without local classification metadata reportable", () => {
    const input = { ...base, openFlagTypes: new Set(["unmapped_product"]) };
    const decision = resolveB2cPaymentDecision(input);
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.reportingDecision).toBe("reportable");
  });

  it("waives the missing-email rule through an exception, but never a duplicate or failed status", () => {
    const exception = { ...base, customerEmail: null, hasFinanceException: true };
    expect(resolveB2cPaymentDecision(exception).reportingDecision).toBe("exception_included");
    expect(resolveB2cPaymentDecision({ ...exception, openFlagTypes: new Set(["possible_duplicate"]) }).reportingDecision).toBe("blocked");
    expect(resolveB2cPaymentDecision({ ...exception, paymentStatus: "failed" }).reportingDecision).toBe("blocked");
  });
});
