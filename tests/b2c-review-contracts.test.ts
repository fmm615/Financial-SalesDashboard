import { describe, expect, it } from "vitest";
import { b2cPaymentLocalCorrectionSchema } from "@/lib/validation/b2c-review-contracts";

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
});
