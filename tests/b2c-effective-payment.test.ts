import { describe, expect, it } from "vitest";
import { resolveEffectiveB2cPayment } from "@/lib/b2c/effective-payment";

describe("effective B2C payment", () => {
  const source = {
    customerName: "Stripe source name",
    customerEmail: "source@example.com",
    customerPhone: null,
    categoryCode: "unmapped",
    membershipTier: null,
    amountUsd: "100.000000",
    occurredOn: "2026-08-01",
  };

  it("uses a local reporting overlay without altering the immutable source values", () => {
    const effective = resolveEffectiveB2cPayment(source, {
      customerEmail: "verified@example.com",
      categoryCode: "membership",
      amountUsd: "120.000000",
      occurredOn: "2026-08-03",
    });

    expect(effective).toMatchObject({
      customerName: "Stripe source name",
      customerEmail: "verified@example.com",
      categoryCode: "membership",
      amountUsd: "120.000000",
      occurredOn: "2026-08-03",
      hasLocalCorrection: true,
    });
    expect(effective.correctedFields).toEqual(["customerEmail", "categoryCode", "amountUsd", "occurredOn"]);
    expect(source).toEqual({
      customerName: "Stripe source name",
      customerEmail: "source@example.com",
      customerPhone: null,
      categoryCode: "unmapped",
      membershipTier: null,
      amountUsd: "100.000000",
      occurredOn: "2026-08-01",
    });
  });

  it("keeps the source view unchanged when no local correction exists", () => {
    expect(resolveEffectiveB2cPayment(source, null)).toMatchObject({ ...source, hasLocalCorrection: false, correctedFields: [] });
  });
});
