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
});
