import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isReportableB2cPayment } from "@/lib/b2c/payment-reportability";
import { B2cOperations } from "@/features/b2c/b2c-operations";
import { resolveB2cContactDisplay, type B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations/b2c",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("B2C Stripe enrichment presentation", () => {
  it("shows mutable Stripe contacts as labelled fallbacks without making the payment reportable", () => {
    const display = resolveB2cContactDisplay({
      customerName: null, customerEmail: null, customerPhone: null,
      hasLocalCorrection: false, correctedFields: [],
    }, {
      customerName: "Current Stripe Name", customerNameLabel: "Stripe profile",
      customerEmail: "current-profile@example.com", customerEmailLabel: "Stripe profile",
      customerPhone: "+973 1700 0000", customerPhoneLabel: "Stripe payment method",
    });

    expect(display).toMatchObject({ customerName: "Current Stripe Name", customerEmail: "current-profile@example.com", customerPhone: "+973 1700 0000" });
    expect(isReportableB2cPayment({ paymentStatus: "succeeded", customerEmail: null, categoryCode: "membership", openFlagTypes: new Set(["needs_follow_up"]) })).toBe(false);

    const row = {
      id: "payment-1", recordType: "Payment" as const,
      customerName: display.customerName, customerEmail: display.customerEmail, customerPhone: display.customerPhone,
      customerNameEvidenceLabel: display.customerNameLabel, customerEmailEvidenceLabel: display.customerEmailLabel, customerPhoneEvidenceLabel: display.customerPhoneLabel,
      date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$50.42", amountValueUsd: "50.42", sourceAmountUsd: "$50.42", sourceDateValue: "2026-08-09",
      category: "membership", membershipTier: "Monthly", billingInterval: "Monthly", source: "Stripe", paymentStatus: "Completed" as const,
      providerReference: "ch_123", sourceSystem: "stripe" as const, productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
      openReviewFlags: [], issue: "Missing customer email" as const,
    };
    const snapshot: B2cDashboardSnapshot = {
      period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-12T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true, eligiblePaymentsUsd: "$0.00", refundsUsd: "$0.00", netPaymentsUsd: "$0.00", completedSourcePaymentsUsd: "$50.42", sourceRefundsUsd: "$0.00",
      calculation: { completedSourcePaymentCount: 1, reportablePaymentCount: 0, excludedCompletedPaymentCount: 1, excludedCompletedPaymentsUsd: "$50.42", sourceRefundCount: 0, eligibleRefundCount: 0, missingCustomerEmailCount: 1, unmappedProductCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
      reviewItems: 1, rows: [row],
    };

    render(<B2cOperations snapshot={snapshot} />);
    expect(screen.getByText("current-profile@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("Stripe profile")).toHaveLength(2);
    expect(screen.getByText("Stripe payment method")).toBeInTheDocument();
    expect(screen.getAllByText("Missing customer email").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
  });

  it("keeps a local correction ahead of Stripe fallbacks", () => {
    expect(resolveB2cContactDisplay({
      customerName: "Verified Name", customerEmail: "verified@example.com", customerPhone: "+973 1800 0000",
      hasLocalCorrection: true, correctedFields: ["customerName", "customerEmail", "customerPhone"],
    }, {
      customerName: "Profile Name", customerNameLabel: "Stripe profile", customerEmail: "profile@example.com", customerEmailLabel: "Stripe profile", customerPhone: "+973 1900 0000", customerPhoneLabel: "Stripe profile",
    })).toEqual({
      customerName: "Verified Name", customerNameLabel: null,
      customerEmail: "verified@example.com", customerEmailLabel: null,
      customerPhone: "+973 1800 0000", customerPhoneLabel: null,
    });
  });
});
