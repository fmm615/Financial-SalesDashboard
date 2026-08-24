import { describe, expect, it } from "vitest";
import { decorateB2cLedgerRow, pageB2cLedgerRows, type B2cLedgerQuery } from "@/server/repositories/b2c-ledger-repository";
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

  it("applies every Ledger-only filter before paging, including refund amounts by absolute USD value", () => {
    const rows = [
      decorateB2cLedgerRow({ ...baseRow, id: "completed", customerPhone: "+973 1700 0000" }),
      decorateB2cLedgerRow({ ...baseRow, id: "refunded", dateValue: "2026-08-12", paymentStatus: "Refunded", amountValueUsd: "-48.450000", amountUsd: "-$48.45" }),
      decorateB2cLedgerRow({ ...baseRow, id: "fx-review", dateValue: "2026-08-11", amountValueUsd: null, amountUsd: "18.00 BHD", sourceOriginalCurrency: "BHD", foreignCurrencyReview: true, paymentStatus: "Pending", issue: "Needs FX review" }),
      decorateB2cLedgerRow({ ...baseRow, id: "outside-date", dateValue: "2026-07-31", amountValueUsd: "5.000000", amountUsd: "$5.00", category: "other", issue: "Needs follow-up" }),
    ];

    expect(pageB2cLedgerRows(rows, {
      dateFrom: "2026-08-01", dateTo: "2026-08-31", category: "membership",
    } as unknown as B2cLedgerQuery).rows.map((row) => row.id)).toEqual(["completed", "refunded", "fx-review"]);
    expect(pageB2cLedgerRows(rows, { foreignCurrencyOnly: true } as unknown as B2cLedgerQuery).rows.map((row) => row.id)).toEqual(["fx-review"]);
    expect(pageB2cLedgerRows(rows, { issue: "none" } as unknown as B2cLedgerQuery).rows.map((row) => row.id)).toEqual(["completed", "refunded"]);
    expect(pageB2cLedgerRows(rows, { paymentStatus: "Refunded" } as unknown as B2cLedgerQuery).rows.map((row) => row.id)).toEqual(["refunded"]);
    expect(pageB2cLedgerRows(rows, { minAmountUsd: "40", maxAmountUsd: "50" }).rows.map((row) => row.id)).toEqual(["completed", "refunded"]);
    expect(pageB2cLedgerRows(rows, { search: "+973" }).rows.map((row) => row.id)).toEqual(["completed"]);
    expect(pageB2cLedgerRows(rows, { search: "membership" }).rows).toEqual([]);
  });

  it("returns safe filter metadata from the full period before applying the current page query", () => {
    const page = pageB2cLedgerRows([
      decorateB2cLedgerRow({ ...baseRow, id: "stripe-row" }),
      decorateB2cLedgerRow({ ...baseRow, id: "tap-row", source: "Tap", sourceSystem: "tap", category: "course", issue: "Needs follow-up", foreignCurrencyReview: true }),
    ], { source: "stripe", limit: 1 });

    expect((page as unknown as { filterMetadata?: unknown }).filterMetadata).toEqual({
      sources: ["Stripe", "Tap"],
      categories: ["course", "membership"],
      issues: ["Needs follow-up"],
      foreignCurrencyCount: 1,
    });
  });
});
