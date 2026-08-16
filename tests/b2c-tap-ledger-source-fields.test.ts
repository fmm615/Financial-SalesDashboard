import { describe, expect, it } from "vitest";
import { resolveLedgerSourceDescription } from "@/server/repositories/b2c-dashboard-repository";

describe("Tap B2C ledger source fields", () => {
  it("uses the retained Tap description when Stripe evidence is absent", () => {
    expect(resolveLedgerSourceDescription({ description: "Sale - Fatima Abbas" }, null)).toBe("Sale - Fatima Abbas");
  });

  it("keeps richer Stripe evidence ahead of generic retained metadata", () => {
    expect(resolveLedgerSourceDescription({ description: "Generic payment description" }, "Founding Membership renewal"))
      .toBe("Founding Membership renewal");
  });
});
