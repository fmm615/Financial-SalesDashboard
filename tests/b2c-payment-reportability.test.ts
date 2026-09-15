import { describe, expect, it } from "vitest";
import { b2cPaymentExclusionReasons, isReportableB2cPayment } from "@/lib/b2c/payment-reportability";

describe("B2C payment reportability", () => {
  const completePayment = {
    paymentStatus: "succeeded" as const,
    customerEmail: "member@example.com",
    openFlagTypes: new Set<string>(),
  };

  it("counts a completed, non-reviewable source payment regardless of optional classification metadata", () => {
    expect(isReportableB2cPayment(completePayment)).toBe(true);
    expect(b2cPaymentExclusionReasons(completePayment)).toEqual([]);
  });

  it("does not block a provider payment on optional classification metadata", () => {
    const input = {
      paymentStatus: "succeeded" as const,
      customerEmail: "member@example.com",
      openFlagTypes: new Set(["unmapped_product"]),
      originalCurrency: "USD",
      amountUsd: "120.000000",
    };

    expect(b2cPaymentExclusionReasons(input)).toEqual([]);
    expect(isReportableB2cPayment(input)).toBe(true);
  });

  it.each([
    ["missing email", { customerEmail: null }, ["missing_customer_email"]],
    ["failed status", { paymentStatus: "failed" as const }, ["not_succeeded"]],
    ["pending status", { paymentStatus: "pending" as const }, ["not_succeeded"]],
    ["missing FX", { originalCurrency: "BHD", amountUsd: null }, ["needs_fx_review"]],
    ["possible duplicate", { openFlagTypes: new Set(["possible_duplicate"]) }, ["possible_duplicate"]],
    ["duplicate exclusion", { hasDuplicateExclusion: true }, ["duplicate_exclusion"]],
    ["blocking follow-up", { hasBlockingNeedsFollowUp: true }, ["needs_follow_up"]],
  ] as const)("keeps a source payment out of totals for %s", (_caseName, overrides, expectedReasons) => {
    const input = { ...completePayment, ...overrides };
    expect(b2cPaymentExclusionReasons(input)).toEqual(expectedReasons);
    expect(isReportableB2cPayment(input)).toBe(false);
  });

  it("allows only the documented missing-data exception while preserving duplicate and failed blocks", () => {
    const approvedException = {
      ...completePayment,
      customerEmail: null,
      openFlagTypes: new Set(["needs_follow_up", "unmapped_product"]),
      hasFinanceException: true,
      hasBlockingNeedsFollowUp: false,
    };
    expect(isReportableB2cPayment(approvedException)).toBe(true);
    expect(isReportableB2cPayment({ ...approvedException, openFlagTypes: new Set(["possible_duplicate"]) })).toBe(false);
    expect(isReportableB2cPayment({ ...approvedException, paymentStatus: "failed" })).toBe(false);
  });

  it("allows a missing e-mail only for a payment with immutable approved Finance provenance", () => {
    const approvedFinancePayment = {
      ...completePayment,
      customerEmail: null,
      isApprovedFinancePayment: true,
    };
    expect(isReportableB2cPayment(approvedFinancePayment)).toBe(true);
    expect(isReportableB2cPayment({ ...approvedFinancePayment, isApprovedFinancePayment: false })).toBe(false);
    expect(isReportableB2cPayment({ ...approvedFinancePayment, openFlagTypes: new Set(["possible_duplicate"]) })).toBe(false);
    expect(isReportableB2cPayment({ ...approvedFinancePayment, paymentStatus: "pending" })).toBe(false);
  });

  it("keeps foreign-currency source activity out of USD financial totals until Finance has an approved conversion", () => {
    const foreignCurrencyPayment = {
      ...completePayment,
      originalCurrency: "BHD",
      amountUsd: null,
      hasFinanceException: true,
    };
    expect(b2cPaymentExclusionReasons(foreignCurrencyPayment)).toContain("needs_fx_review");
    expect(isReportableB2cPayment(foreignCurrencyPayment)).toBe(false);
  });

  it("allows a foreign-currency payment into USD totals only after its local USD conversion exists", () => {
    const convertedForeignCurrencyPayment = {
      ...completePayment,
      originalCurrency: "BHD",
      amountUsd: "132.94",
    };

    expect(b2cPaymentExclusionReasons(convertedForeignCurrencyPayment)).not.toContain("needs_fx_review");
    expect(isReportableB2cPayment(convertedForeignCurrencyPayment)).toBe(true);
  });

  it("keeps a payment with a resolved duplicate exclusion out of totals even with no open raw flag", () => {
    const reasons = b2cPaymentExclusionReasons({
      ...completePayment,
      hasDuplicateExclusion: true,
    });

    expect(reasons).toEqual(["duplicate_exclusion"]);
    expect(isReportableB2cPayment({ ...completePayment, hasDuplicateExclusion: true })).toBe(false);
  });
});
