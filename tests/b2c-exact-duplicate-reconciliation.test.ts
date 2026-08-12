import { describe, expect, it } from "vitest";
import {
  isExactFinanceCrossTabPair,
  isUnambiguousExactFinanceKey,
  type ExactFinanceRow,
} from "@/server/services/b2c-exact-duplicate-reconciliation";

const b2cRow: ExactFinanceRow = {
  id: "b2c-row", importId: "import-1", sourceTab: "B2C", quality: "valid",
  occurredOn: "2025-10-05", amountUsd: "475", category: "b2c-membership", paymentMethod: "stripe",
  normalizedCustomerName: "reham garash", normalizedCustomerEmail: "rgarash@gmail.com", normalizedCustomerPhone: null,
};

const b2cConsRow: ExactFinanceRow = {
  ...b2cRow, id: "b2c-cons-row", sourceTab: "B2C Cons",
};

describe("exact B2C Finance duplicate rules", () => {
  it("accepts one exact cross-tab e-mail match from one completed-import candidate set", () => {
    expect(isExactFinanceCrossTabPair(b2cRow, b2cConsRow)).toBe(true);
    expect(isUnambiguousExactFinanceKey([b2cRow, b2cConsRow])).toBe(true);
  });

  it("rejects a same-customer same-day row when a financial field differs", () => {
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, amountUsd: "476" })).toBe(false);
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, category: "other" })).toBe(false);
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, paymentMethod: "bank transfer" })).toBe(false);
  });

  it("allows name and phone only when e-mail is absent on both rows", () => {
    const noEmailB2c = { ...b2cRow, normalizedCustomerEmail: null, normalizedCustomerPhone: "97336001234" };
    const noEmailCons = { ...b2cConsRow, normalizedCustomerEmail: null, normalizedCustomerPhone: "97336001234" };

    expect(isExactFinanceCrossTabPair(noEmailB2c, noEmailCons)).toBe(true);
    expect(isExactFinanceCrossTabPair(noEmailB2c, { ...noEmailCons, normalizedCustomerPhone: null })).toBe(false);
    expect(isExactFinanceCrossTabPair(noEmailB2c, { ...b2cConsRow, normalizedCustomerEmail: "other@playbook.test" })).toBe(false);
  });

  it("keeps recurring and repeated same-day records out of automatic grouping", () => {
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, occurredOn: "2025-11-05" })).toBe(false);
    expect(isUnambiguousExactFinanceKey([b2cRow, b2cConsRow, { ...b2cRow, id: "second-b2c" }])).toBe(false);
  });
});
