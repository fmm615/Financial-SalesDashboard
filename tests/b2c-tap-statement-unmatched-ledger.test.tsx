import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cOperations } from "@/features/b2c/b2c-operations";
import {
  mapTapStatementUnmatchedLedgerRows,
  resolveB2cReportingPeriod,
  type B2cDashboardSnapshot,
  type B2cLedgerRow,
} from "@/server/repositories/b2c-dashboard-repository";

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

describe("Tap statement unmatched ledger review", () => {
  it("retains undated Tap statement evidence in All time review without inventing a business date", () => {
    const rows = mapTapStatementUnmatchedLedgerRows([
      {
        evidence_id: "tap-evidence-undated",
        provider_payment_id: "chg_statement_without_date",
        description_raw: "Sale - Date unavailable",
        occurred_at: null,
        original_currency: "BHD",
        original_amount: "207.110000",
      },
    ], resolveB2cReportingPeriod("all", new Date("2026-08-16T00:00:00.000Z")));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "Date unavailable",
      dateValue: "",
      sourceDateValue: "",
      amountUsd: "207.110000 BHD",
      issue: "Tap statement unmatched",
      tapStatementUnmatched: true,
    });
  });

  it("keeps the Tap statement filter visible when no unmatched statement rows are loaded", async () => {
    const snapshot = {
      period: { month: "all", monthLabel: "All time", monthStart: "2026-08-01", monthEnd: "2026-08-31", isAllTime: true },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-16T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true,
      eligiblePaymentsUsd: "$50.42", refundsUsd: "$0.00", netPaymentsUsd: "$50.42", completedSourcePaymentsUsd: "$50.42", sourceRefundsUsd: "$0.00",
      calculation: { completedSourcePaymentCount: 1, reportablePaymentCount: 1, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 0, eligibleRefundCount: 0, missingCustomerEmailCount: 0, unmappedProductCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
      reviewItems: 0,
      rows: [],
    } as unknown as B2cDashboardSnapshot;
    stubWorkspaceFetch([]);

    render(<B2cOperations snapshot={snapshot} />);

    expect(await screen.findByRole("button", { name: "Tap statement unmatched (0)" })).toBeDisabled();
  });

  it("shows the retained global count even when an undated statement item is outside the selected month", () => {
    const snapshot = {
      period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-16T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true,
      eligiblePaymentsUsd: "$0.00", refundsUsd: "$0.00", netPaymentsUsd: "$0.00", completedSourcePaymentsUsd: "$0.00", sourceRefundsUsd: "$0.00",
      calculation: { completedSourcePaymentCount: 0, reportablePaymentCount: 0, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 0, eligibleRefundCount: 0, missingCustomerEmailCount: 0, unmappedProductCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
      reviewItems: 0,
      tapStatementUnmatchedCount: 3,
      rows: [],
    } as unknown as B2cDashboardSnapshot;
    stubWorkspaceFetch([]);

    render(<B2cOperations snapshot={snapshot} />);

    expect(screen.getByRole("button", { name: "Tap statement unmatched (3)" })).toBeEnabled();
  });

  it("shows unmatched Tap statement sales through the existing ledger filter", async () => {
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
    stubWorkspaceFetch(snapshot.rows);

    render(<B2cOperations snapshot={snapshot} />);

    expect(await screen.findByRole("button", { name: "Tap statement unmatched (1)" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "B2C ledger" });
    expect(within(table).getByText("Normal payment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tap statement unmatched (1)" }));

    expect(await within(table).findByText("18.00 BHD")).toBeInTheDocument();
    expect(within(table).getByText("Not matched to Tap API")).toBeInTheDocument();
    expect(within(table).queryByText("Normal payment")).not.toBeInTheDocument();
  });
});
