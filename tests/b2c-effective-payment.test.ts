import { describe, expect, it } from "vitest";
import { resolveEffectiveB2cPayment } from "@/lib/b2c/effective-payment";

describe("effective B2C payment values", () => {
  const foreignSource = {
    customerName: null,
    customerEmail: "member@example.com",
    customerPhone: null,
    categoryCode: "membership",
    membershipTier: null,
    amountUsd: null,
    occurredOn: "2026-08-13",
  };

  it("uses the latest Finance FX conversion without overwriting the BHD source", () => {
    const effective = resolveEffectiveB2cPayment(foreignSource, null, { amountUsd: "132.940000" });

    expect(effective.amountUsd).toBe("132.940000");
    expect(effective.hasLocalCorrection).toBe(false);
    expect(effective.correctedFields).toEqual([]);
  });

  it("does not use a generic local USD override for a foreign source", () => {
    const effective = resolveEffectiveB2cPayment(
      { ...foreignSource, originalCurrency: "BHD" },
      { amountUsd: "132.940000" },
    );

    expect(effective.amountUsd).toBeNull();
  });
});
