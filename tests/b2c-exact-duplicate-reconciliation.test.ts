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
  it("accepts one exact name, date, amount, and method pair despite incompatible cross-tab contact and category fields", () => {
    const sourceStructuredConsRow = {
      ...b2cConsRow,
      category: "b2c-membership",
      normalizedCustomerEmail: null,
      normalizedCustomerPhone: null,
    };

    expect(isExactFinanceCrossTabPair(b2cRow, sourceStructuredConsRow)).toBe(true);
    expect(isUnambiguousExactFinanceKey([b2cRow, sourceStructuredConsRow])).toBe(true);
  });

  it("rejects a cross-tab row when a shared comparison field differs", () => {
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, amountUsd: "476" })).toBe(false);
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, normalizedCustomerName: "another member" })).toBe(false);
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, paymentMethod: "bank transfer" })).toBe(false);
  });

  it("requires a non-empty normalized name even when other shared fields match", () => {
    expect(isExactFinanceCrossTabPair(
      { ...b2cRow, normalizedCustomerName: null },
      { ...b2cConsRow, normalizedCustomerName: null },
    )).toBe(false);
  });

  it("keeps recurring and repeated same-day records out of automatic grouping", () => {
    expect(isExactFinanceCrossTabPair(b2cRow, { ...b2cConsRow, occurredOn: "2025-11-05" })).toBe(false);
    expect(isUnambiguousExactFinanceKey([b2cRow, b2cConsRow, { ...b2cRow, id: "second-b2c" }])).toBe(false);
  });
});
