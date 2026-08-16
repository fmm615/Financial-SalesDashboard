import { describe, expect, it } from "vitest";
import { b2cPaymentExclusionReasons, isReportableB2cPayment } from "@/lib/b2c/payment-reportability";

describe("B2C payment reportability", () => {
  const completePayment = {
    paymentStatus: "succeeded" as const,
    customerEmail: "member@example.com",
    categoryCode: "membership",
    openFlagTypes: new Set<string>(),
  };

  it("counts only a completed, categorised, non-reviewable source payment", () => {
    expect(isReportableB2cPayment(completePayment)).toBe(true);
    expect(b2cPaymentExclusionReasons(completePayment)).toEqual([]);
  });

  it("keeps a source payment out of totals for every approved exclusion reason", () => {
    expect(b2cPaymentExclusionReasons({ ...completePayment, customerEmail: null, categoryCode: "unmapped", openFlagTypes: new Set(["possible_duplicate", "needs_follow_up"]) })).toEqual([
      "missing_customer_email", "unmapped_product", "possible_duplicate", "needs_follow_up",
    ]);
    expect(isReportableB2cPayment({ ...completePayment, paymentStatus: "failed" })).toBe(false);
  });

  it("allows only the documented missing-data exception while preserving duplicate and failed blocks", () => {
    const approvedException = {
      ...completePayment,
      customerEmail: null,
      categoryCode: "membership",
      openFlagTypes: new Set(["needs_follow_up", "unmapped_product"]),
      hasFinanceException: true,
      hasBlockingNeedsFollowUp: false,
    };
    expect(isReportableB2cPayment(approvedException)).toBe(true);
    expect(isReportableB2cPayment({ ...approvedException, openFlagTypes: new Set(["possible_duplicate"]) })).toBe(false);
    expect(isReportableB2cPayment({ ...approvedException, paymentStatus: "failed" })).toBe(false);
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
});
