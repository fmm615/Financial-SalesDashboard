import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isReportableB2cPayment } from "@/lib/b2c/payment-reportability";
import { B2cOperations } from "@/features/b2c/b2c-operations";
import { resolveB2cContactDisplay, resolveB2cLedgerSourceLabel, type B2cDashboardSnapshot, type B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations/b2c",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=ledger"),
}));

afterEach(() => vi.unstubAllGlobals());

/** The Ledger tab loads its rows from `/api/b2c/workspace`; the header totals still come from the snapshot prop. */
function stubWorkspaceFetch(rows: B2cLedgerRow[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ role: "admin", ledger: { rows, nextCursor: null, hasMore: false, totalCount: rows.length }, workItems: null }),
  }));
}

describe("B2C Stripe enrichment presentation", () => {
  it("labels approved Finance rows by their retained payment method", () => {
    expect(resolveB2cLedgerSourceLabel("finance_tracker", { finance_payment_method: "bank_transfer" })).toBe("Finance — Bank transfer");
    expect(resolveB2cLedgerSourceLabel("finance_tracker", { finance_payment_method: "ios" })).toBe("Finance — iOS");
    expect(resolveB2cLedgerSourceLabel("finance_tracker", {})).toBe("Finance");
  });

  it("shows mutable Stripe contacts as labelled fallbacks without making the payment reportable", async () => {
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
      date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$50.42", amountValueUsd: "50.42", sourceAmountUsd: "$50.42", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-09",
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

    stubWorkspaceFetch([row]);
    render(<B2cOperations snapshot={snapshot} />);

    // The ledger row itself shows only customer, date, amount, source, status,
    // and one `Review` action (see "Final B2C UI Inventory": desktop columns
    // are limited to those six). Provider-supplied contact fallbacks and their
    // evidence labels move into the shared drawer -- Task 5 populates that
    // detail; Task 4 verifies the row is not blocked from opening it.
    const table = await screen.findByRole("table", { name: "B2C ledger" });
    expect(within(table).getByText("Missing customer email")).toBeInTheDocument();
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);

    fireEvent.click(within(table).getByRole("button", { name: "Review" }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("current-profile@example.com")).toBeInTheDocument();
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

  it("shows safe Stripe settlement evidence without changing the B2C reporting amount", async () => {
    const row = {
      id: "payment-evidence-1", recordType: "Payment" as const,
      customerName: "Stripe customer", customerEmail: "customer@example.com", customerPhone: null,
      customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
      date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$50.42", amountValueUsd: "50.42", sourceAmountUsd: "$50.42", sourceOriginalCurrency: "USD", sourceDescription: "Founding Membership renewal", sourceDateValue: "2026-08-09",
      category: "membership", membershipTier: "Founding Membership", billingInterval: "Annual", source: "Stripe", paymentStatus: "Completed" as const,
      providerReference: "ch_123", sourceSystem: "stripe" as const, productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
      openReviewFlags: [], issue: null,
      stripeEvidence: {
        originalAmount: "50.42", originalCurrency: "USD", amountRefunded: "10.00", description: "Founding Membership renewal", sellerMessage: "Payment complete", cardholderName: "Stripe customer",
        settlementGrossAmount: "50.42", settlementFeeAmount: "1.75", settlementFeeTaxAmount: "0.18", settlementNetAmount: "48.67", settlementCurrency: "BHD", settlementExchangeRate: 0.376 as unknown as string, refunds: [{ refundId: "refund-1", originalAmount: "10.00", originalCurrency: "USD", settlementRefundAmount: "10.00", settlementCurrency: "BHD", settlementExchangeRate: "0.376" }],
      },
    };
    const snapshot: B2cDashboardSnapshot = {
      period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-12T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true, eligiblePaymentsUsd: "$50.42", refundsUsd: "$10.00", netPaymentsUsd: "$40.42", completedSourcePaymentsUsd: "$50.42", sourceRefundsUsd: "$10.00",
      calculation: { completedSourcePaymentCount: 1, reportablePaymentCount: 1, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 1, eligibleRefundCount: 1, missingCustomerEmailCount: 0, unmappedProductCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
      reviewItems: 0, rows: [row],
    };

    stubWorkspaceFetch([row]);
    render(<B2cOperations snapshot={snapshot} />);

    // The fourteen-column ledger and its per-row `View Stripe details` dialog
    // are removed (see "Remove" in the implementation plan's UI inventory):
    // desktop columns are limited to customer, date, amount, source, status,
    // and one `Review` action. Source currency, description, and Stripe
    // settlement evidence move into the shared drawer, which Task 5 populates.
    const table = await screen.findByRole("table", { name: "B2C ledger" });
    expect(within(table).queryByRole("columnheader", { name: "Source currency" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Description" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "View Stripe details" })).not.toBeInTheDocument();
    expect(within(table).getByText("Stripe customer")).toBeInTheDocument();
    // The pre-existing reportable metric remains the stored USD amount rather
    // than Stripe's separate BHD settlement/net-payout evidence.
    expect(screen.getAllByText("$50.42").length).toBeGreaterThan(0);
  });
});
