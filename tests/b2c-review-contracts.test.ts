import { describe, expect, it } from "vitest";
import { b2cFinanceExceptionSchema, b2cPaymentLocalCorrectionSchema } from "@/lib/validation/b2c-review-contracts";

describe("B2C local correction contract", () => {
  it("accepts an audited local USD amount or business-date correction", () => {
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ amountUsd: "120.500000", reason: "Finance verified the settled amount." }).success).toBe(true);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ occurredOn: "2026-08-03", reason: "Finance verified the business date." }).success).toBe(true);
  });

  it("rejects zero, imprecise, and unaudited financial corrections", () => {
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ amountUsd: "0", reason: "Verified" }).success).toBe(false);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ amountUsd: "12.1234567", reason: "Verified" }).success).toBe(false);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ occurredOn: "2026-08-03", reason: "" }).success).toBe(false);
  });

  it("rejects placeholder values so unavailable data is never saved as a correction", () => {
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ customerName: "-", reason: "Finance verified the record." }).success).toBe(false);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ categoryCode: "unmapped", reason: "Finance verified the record." }).success).toBe(false);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({ categoryCode: "membership", reason: "---" }).success).toBe(false);
  });
});

describe("B2C Finance exception contract", () => {
  it("requires the reason and both explicit Admin confirmations", () => {
    expect(b2cFinanceExceptionSchema.safeParse({ reason: "Verified against Finance evidence", confirmedProviderTransaction: true, confirmedNoKnownDuplicate: true }).success).toBe(true);
    expect(b2cFinanceExceptionSchema.safeParse({ reason: "Verified against Finance evidence", confirmedProviderTransaction: false, confirmedNoKnownDuplicate: true }).success).toBe(false);
    expect(b2cFinanceExceptionSchema.safeParse({ reason: "no", confirmedProviderTransaction: true, confirmedNoKnownDuplicate: true }).success).toBe(false);
  });
});
