import { describe, expect, it } from "vitest";
import {
  mapApprovedFinancePostResult,
  normalizeApprovedFinancePaymentMethod,
  normalizeFinanceCategoryCode,
} from "@/lib/b2c/approved-finance-payment";

describe("approved Finance payment rules", () => {
  it("accepts only iOS and bank-transfer Finance payment methods", () => {
    expect(normalizeApprovedFinancePaymentMethod("Bank transfer")).toBe("bank_transfer");
    expect(normalizeApprovedFinancePaymentMethod(" bank_transfer ")).toBe("bank_transfer");
    expect(normalizeApprovedFinancePaymentMethod("iOS")).toBe("ios");
    expect(normalizeApprovedFinancePaymentMethod("Stripe")).toBeNull();
    expect(normalizeApprovedFinancePaymentMethod(null)).toBeNull();
  });

  it("turns a retained Finance category into the ledger category-code format", () => {
    expect(normalizeFinanceCategoryCode("B2C- Membership")).toBe("b2c-membership");
    expect(normalizeFinanceCategoryCode(" Founding Member Membership ")).toBe("founding-member-membership");
    expect(normalizeFinanceCategoryCode("   ")).toBeNull();
  });

  it("accepts only a complete numeric posting result from the database", () => {
    expect(mapApprovedFinancePostResult({ posted_payments: 2, already_posted_payments: 1, skipped_rows: 3 })).toEqual({
      postedPayments: 2,
      alreadyPostedPayments: 1,
      skippedRows: 3,
    });
    expect(mapApprovedFinancePostResult({ posted_payments: 2, already_posted_payments: -1, skipped_rows: 3 })).toBeNull();
    expect(mapApprovedFinancePostResult({ posted_payments: 2 })).toBeNull();
  });
});
