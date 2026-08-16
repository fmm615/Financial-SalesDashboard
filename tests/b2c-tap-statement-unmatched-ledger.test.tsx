import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { B2cOperations } from "@/features/b2c/b2c-operations";
import type { B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations/b2c",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("Tap statement unmatched ledger review", () => {
  it("shows unmatched Tap statement sales through the existing ledger filter", () => {
    const snapshot = {
      period: { month: "all", monthLabel: "All time", monthStart: "2026-08-01", monthEnd: "2026-08-31", isAllTime: true },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-16T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true,
      eligiblePaymentsUsd: "$50.42", refundsUsd: "$0.00", netPaymentsUsd: "$50.42", completedSourcePaymentsUsd: "$50.42", sourceRefundsUsd: "$0.00",
      calculation: { completedSourcePaymentCount: 1, reportablePaymentCount: 1, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 0, eligibleRefundCount: 0, missingCustomerEmailCount: 0, unmappedProductCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
      reviewItems: 0,
      rows: [
        {
          id: "payment-1", recordType: "Payment", customerName: "Normal payment", customerEmail: "normal@example.com", customerPhone: null,
          customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
          date: "Aug 1, 2026", dateValue: "2026-08-01", amountUsd: "$50.42", amountValueUsd: "50.42", sourceAmountUsd: "$50.42", sourceOriginalAmount: "50.42", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-01",
          category: "membership", membershipTier: null, billingInterval: null, source: "Stripe", paymentStatus: "Completed", providerReference: "ch_123", sourceSystem: "stripe", productReference: null,
          hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false, openReviewFlags: [], issue: null,
        },
        {
          id: "tap-statement-1", recordType: "Tap statement sale", customerName: null, customerEmail: null, customerPhone: null,
          customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
          date: "Jun 1, 2024", dateValue: "2024-06-01", amountUsd: "18.00 BHD", amountValueUsd: null, sourceAmountUsd: "18.00 BHD", sourceOriginalAmount: "18.00", sourceOriginalCurrency: "BHD", sourceDescription: "Sale - Statement-only customer", sourceDateValue: "2024-06-01",
          category: "Unavailable", membershipTier: null, billingInterval: null, source: "Tap", paymentStatus: "Not matched", providerReference: "chg_statement_only", sourceSystem: "tap", productReference: null,
          hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false, openReviewFlags: [], issue: "Tap statement unmatched", tapStatementUnmatched: true,
        },
      ],
    } as unknown as B2cDashboardSnapshot;

    render(<B2cOperations snapshot={snapshot} />);

    expect(screen.getByRole("button", { name: "Tap statement unmatched (1)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tap statement unmatched (1)" }));

    expect(screen.getByText("Sale - Statement-only customer")).toBeInTheDocument();
    expect(screen.getByText("Not matched to Tap API")).toBeInTheDocument();
    expect(screen.queryByText("Normal payment")).not.toBeInTheDocument();
  });
});
