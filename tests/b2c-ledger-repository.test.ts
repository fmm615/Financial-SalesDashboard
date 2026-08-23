import { describe, expect, it } from "vitest";
import { decorateB2cLedgerRow } from "@/server/repositories/b2c-ledger-repository";
import type { B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

const baseRow: B2cLedgerRow = {
  id: "11111111-1111-4111-8111-111111111111",
  recordType: "Payment",
  customerName: "Member",
  customerEmail: "member@example.com",
  customerPhone: null,
  customerNameEvidenceLabel: null,
  customerEmailEvidenceLabel: null,
  customerPhoneEvidenceLabel: null,
  date: "Aug 13, 2026",
  dateValue: "2026-08-13",
  amountUsd: "$48.45",
  amountValueUsd: "48.450000",
  sourceAmountUsd: "$48.45",
  sourceDescription: null,
  sourceDateValue: "2026-08-13",
  category: "membership",
  membershipTier: null,
  billingInterval: null,
  source: "Stripe",
  paymentStatus: "Completed",
  providerReference: "ch_123",
  sourceSystem: "stripe",
  productReference: null,
  hasLocalCorrection: false,
  localCorrectionFields: [],
  hasFinanceException: false,
  hasOpenPaymentDuplicate: true,
  hasDuplicateExclusion: false,
  openReviewFlags: [],
  issue: null,
};

describe("B2C ledger repository", () => {
  it("decorates safe open duplicate state without exposing duplicate group membership", () => {
    const row = decorateB2cLedgerRow(baseRow, new Date("2026-08-20T00:00:00.000Z"));

    expect(row.decision.reconciliationStatus).toBe("duplicate_pending");
    expect(row.decision.reportingDecision).toBe("blocked");
    expect(row.decision.blockingReasons).toEqual(["possible_duplicate"]);
    expect(Object.keys(row)).not.toContain("duplicateGroupId");
    expect(Object.keys(row)).not.toContain("duplicatePaymentIds");
  });

  it("decorates a safe duplicate exclusion as excluded even after its raw flag is closed", () => {
    const row = decorateB2cLedgerRow({
      ...baseRow,
      hasOpenPaymentDuplicate: false,
      hasDuplicateExclusion: true,
    }, new Date("2026-08-20T00:00:00.000Z"));

    expect(row.decision.reportingDecision).toBe("excluded");
    expect(row.decision.blockingReasons).toEqual(["duplicate_exclusion"]);
  });
});
