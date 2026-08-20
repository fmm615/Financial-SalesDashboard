import { describe, expect, it } from "vitest";
import { financeWorkbookRowSchema } from "@/lib/validation/b2c-finance-import-contracts";
import {
  assessFinanceRow,
  classifyTapEvidence,
  compareFinanceRows,
} from "@/server/services/b2c-finance-reconciliation";

describe("B2C Finance workbook assessment", () => {
  it("accepts only the two approved Payment Tracker tabs", () => {
    expect(financeWorkbookRowSchema.safeParse({
      sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-01", amountUsdRaw: "475",
      customerNameRaw: "Abeer", paymentMethodRaw: "Stripe",
    }).success).toBe(true);
    expect(financeWorkbookRowSchema.safeParse({
      sourceTab: "Other", sourceRowNumber: 2, reportedDateRaw: "2026-08-01", amountUsdRaw: "475",
      customerNameRaw: "Abeer", paymentMethodRaw: "Stripe",
    }).success).toBe(false);
  });

  it("retains an Excel date while flagging a conflicting declared month", () => {
    const result = assessFinanceRow({
      sourceTab: "B2C Cons", sourceRowNumber: 2, reportedDateRaw: "45787", declaredMonth: "October", declaredYear: "2025",
      amountUsdRaw: "475", customerNameRaw: "Reham Garash", paymentMethodRaw: "Stripe",
    });

    expect(result.occurredOn).toBe("2025-05-10");
    expect(result.quality).toBe("needs_review");
    expect(result.issues).toContain("declared_month_conflicts_with_date");
  });

  it("holds a business date beyond today for review instead of accepting a future payment as valid", () => {
    const result = assessFinanceRow({
      sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-11-01",
      amountUsdRaw: "48.45", customerNameRaw: "Hoor Alshubbar", paymentMethodRaw: "iOS",
    }, new Date("2026-08-20T00:00:00.000Z"));

    expect(result.occurredOn).toBe("2026-11-01");
    expect(result.quality).toBe("needs_review");
    expect(result.issues).toContain("implausible_future_date");
  });

  it("accepts a date at or one day past today, so a same-day entry near midnight is never wrongly held", () => {
    const today = assessFinanceRow({
      sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-20",
      amountUsdRaw: "100", customerNameRaw: "Abeer", paymentMethodRaw: "Stripe",
    }, new Date("2026-08-20T00:00:00.000Z"));
    const tomorrow = assessFinanceRow({
      sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-21",
      amountUsdRaw: "100", customerNameRaw: "Abeer", paymentMethodRaw: "Stripe",
    }, new Date("2026-08-20T00:00:00.000Z"));

    expect(today.issues).not.toContain("implausible_future_date");
    expect(tomorrow.issues).not.toContain("implausible_future_date");
    expect(today.quality).toBe("valid");
    expect(tomorrow.quality).toBe("valid");
  });

  it("keeps a zero-value source row out of valid Finance revenue candidates", () => {
    const result = assessFinanceRow({
      sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-01", amountUsdRaw: "0",
      customerNameRaw: "Abeer", paymentMethodRaw: "Bank Transfer",
    });

    expect(result.amountUsd).toBe("0");
    expect(result.quality).toBe("zero_value");
  });
});

describe("B2C Finance duplicate comparisons", () => {
  it("marks identical verified customer, date, amount, and method rows as an exact duplicate candidate", () => {
    const result = compareFinanceRows(
      assessFinanceRow({ sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-01", amountUsdRaw: "475", customerNameRaw: "Abeer", customerEmailRaw: "MEMBER@PLAYBOOK.TEST", paymentMethodRaw: "Stripe" }),
      assessFinanceRow({ sourceTab: "B2C Cons", sourceRowNumber: 14, reportedDateRaw: "2026-08-01", amountUsdRaw: "475", customerNameRaw: "Abeer", customerEmailRaw: "member@playbook.test", paymentMethodRaw: "stripe" }),
    );

    expect(result).toBe("exact_duplicate_candidate");
  });

  it("leaves a recurring payment on a later date unmatched instead of calling it a duplicate", () => {
    const result = compareFinanceRows(
      assessFinanceRow({ sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-01", amountUsdRaw: "48.45", customerNameRaw: "Abeer", customerEmailRaw: "member@playbook.test", paymentMethodRaw: "iOS" }),
      assessFinanceRow({ sourceTab: "B2C Cons", sourceRowNumber: 14, reportedDateRaw: "2026-09-01", amountUsdRaw: "48.45", customerNameRaw: "Abeer", customerEmailRaw: "member@playbook.test", paymentMethodRaw: "iOS" }),
    );

    expect(result).toBe("unmatched");
  });

  it("flags an identity-matched same-day amount conflict for Finance review", () => {
    const result = compareFinanceRows(
      assessFinanceRow({ sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2026-08-01", amountUsdRaw: "475", customerNameRaw: "Abeer", customerEmailRaw: "member@playbook.test", paymentMethodRaw: "Stripe" }),
      assessFinanceRow({ sourceTab: "B2C Cons", sourceRowNumber: 14, reportedDateRaw: "2026-08-01", amountUsdRaw: "500", customerNameRaw: "Abeer", customerEmailRaw: "member@playbook.test", paymentMethodRaw: "Stripe" }),
    );

    expect(result).toBe("conflict");
  });
});

describe("Tap statement evidence classification", () => {
  it("keeps a transfer as settlement evidence rather than a sale", () => {
    expect(classifyTapEvidence({
      description: "Transfer - AUB XXXX7002", chargeId: null, refundId: null, currency: "BHD", debit: "0", credit: "100",
    })).toMatchObject({ kind: "transfer", isReportableRevenue: false });
  });

  it("holds a sale line without a Tap charge ID for review", () => {
    expect(classifyTapEvidence({
      description: "Sale - Fatima Abbas", chargeId: null, refundId: null, currency: "BHD", debit: "0", credit: "74.570",
    })).toMatchObject({ kind: "needs_review", issue: "sale_missing_charge_id", isReportableRevenue: false });
  });
});
