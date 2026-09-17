import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cOperations } from "@/features/b2c/b2c-operations";
import { getB2cDashboardSnapshot, resolveB2cContactDisplay, resolveB2cLedgerSourceLabel, type B2cDashboardSnapshot, type B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations/b2c",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=ledger"),
}));

afterEach(() => vi.unstubAllGlobals());

/**
 * The Ledger tab loads its rows from `/api/b2c/workspace`; the header totals
 * still come from the snapshot prop. The shared drawer separately fetches
 * full Stripe evidence from the dedicated Admin-only
 * `/api/admin/b2c/payments/[paymentId]/evidence` read (Task 3's
 * `/api/b2c/workspace` never carries `stripeEvidence`), plus the Viewer-and-
 * Admin-readable audit history read -- both are stubbed here too.
 */
function stubWorkspaceFetch(rows: B2cLedgerRow[], evidenceByPaymentId: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes("/audit-history")) return Promise.resolve({ ok: true, json: async () => ({ entries: [] }) });
    const evidenceMatch = url.match(/\/api\/admin\/b2c\/payments\/([^/]+)\/evidence/);
    if (evidenceMatch) {
      const payload = evidenceByPaymentId[evidenceMatch[1]];
      if (!payload) return Promise.resolve({ ok: false, json: async () => ({ error: "not found" }) });
      return Promise.resolve({ ok: true, json: async () => payload });
    }
    return Promise.resolve({ ok: true, json: async () => ({ role: "admin", ledger: { rows, nextCursor: null, hasMore: false, totalCount: rows.length }, workItems: null }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function dashboardClientForUnmappedProviderPayment(sourceSystem: "stripe" | "tap", description: string | null) {
  const payment = {
    id: sourceSystem === "stripe" ? "81000000-0000-4000-8000-000000000001" : "81000000-0000-4000-8000-000000000002", source_system: sourceSystem, provider_transaction_id: `${sourceSystem}_provider_1`,
    customer_name: "Provider customer", customer_email: "customer@example.com", customer_phone: null,
    membership_tier: null, payment_status: "succeeded",
    original_amount: "120.000000", original_currency: "USD", amount_usd: "120.000000", occurred_on: "2026-08-09",
    source_metadata: description ? { description } : {},
  };
  const rowsByTable: Record<string, unknown[]> = {
    b2c_payments: [payment],
    b2c_refunds: [],
    review_flags: [{ id: "legacy-unmapped-flag", source_area: "b2c_payment", source_record_id: payment.id, flag_type: "unmapped_product", reason: "Historical mapping review." }],
    b2c_payment_local_overrides: [], b2c_payment_fx_conversions: [], b2c_refund_fx_conversions: [],
    b2c_payment_finance_exception_decisions: [], b2c_finance_ledger_posts: [], integration_sync_runs: [],
  };
  const queryFor = (table: string) => {
    const result = { data: rowsByTable[table] ?? [], error: null };
    const query = {
      select: () => query, eq: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  };
  return {
    from: (table: string) => queryFor(table),
    rpc: async (name: string) => ({
      data: name === "get_b2c_ledger_decisions" ? [{
        record_type: "Payment",
        record_id: payment.id,
        decision: {
          source_status: "succeeded",
          reconciliation_status: "not_required",
          reporting_decision: "reportable",
          posting_status: "not_applicable",
          exclusion_reasons: [],
          blocking_reasons: [],
        },
      }] : [],
      error: null,
    }),
  };
}

describe("B2C Stripe enrichment presentation", () => {
  it.each(["stripe", "tap"] as const)("keeps a succeeded unmapped %s payment reportable without a live mapping issue", async (sourceSystem) => {
    const snapshot = await getB2cDashboardSnapshot(
      dashboardClientForUnmappedProviderPayment(sourceSystem, "Provider renewal") as never,
      new Date("2026-08-12T00:00:00.000Z"),
      "2026-08",
    );

    expect(snapshot.eligiblePaymentsUsd).toBe("$120.00");
    expect(snapshot.calculation.reportablePaymentCount).toBe(1);
    expect(snapshot.reviewItems).toBe(0);
    expect(snapshot.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceDescription: "Provider renewal", issue: null, openReviewFlags: [],
      }),
    ]));
  });

  it("labels every Finance row plainly -- no per-method sub-label, since the workbook that could set one is gone", () => {
    expect(resolveB2cLedgerSourceLabel("finance_tracker")).toBe("Finance");
    expect(resolveB2cLedgerSourceLabel("stripe")).toBe("Stripe");
    expect(resolveB2cLedgerSourceLabel("tap")).toBe("Tap");
    expect(resolveB2cLedgerSourceLabel("manual_bank_transfer")).toBe("Manual bank transfer");
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
    const row = {
      id: "payment-1", recordType: "Payment" as const,
      customerName: display.customerName, customerEmail: display.customerEmail, customerPhone: display.customerPhone,
      customerNameEvidenceLabel: display.customerNameLabel, customerEmailEvidenceLabel: display.customerEmailLabel, customerPhoneEvidenceLabel: display.customerPhoneLabel,
      date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$50.42", amountValueUsd: "50.42", sourceAmountUsd: "$50.42", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-09",
      membershipTier: "Monthly", billingInterval: "Monthly", source: "Stripe", paymentStatus: "Completed" as const,
      providerReference: "ch_123", sourceSystem: "stripe" as const, productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
      hasOpenPaymentDuplicate: false, hasDuplicateExclusion: false,
      openReviewFlags: [], issue: "Missing customer email" as const,
      decision: { sourceStatus: "succeeded" as const, reconciliationStatus: "not_required" as const, reportingDecision: "blocked" as const, postingStatus: "not_applicable" as const, blockingReasons: ["missing_customer_email" as const], explanation: "Blocked by a missing customer email." },
    };
    const snapshot: B2cDashboardSnapshot = {
      period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-12T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true, eligiblePaymentsUsd: "$0.00", refundsUsd: "$0.00", netPaymentsUsd: "$0.00", completedSourcePaymentsUsd: "$50.42", sourceRefundsUsd: "$0.00",
      calculation: { completedSourcePaymentCount: 1, reportablePaymentCount: 0, excludedCompletedPaymentCount: 1, excludedCompletedPaymentsUsd: "$50.42", sourceRefundCount: 0, eligibleRefundCount: 0, missingCustomerEmailCount: 1, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
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
      membershipTier: "Founding Membership", billingInterval: "Annual", source: "Stripe", paymentStatus: "Completed" as const,
      providerReference: "ch_123", sourceSystem: "stripe" as const, productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
      hasOpenPaymentDuplicate: false, hasDuplicateExclusion: false,
      openReviewFlags: [], issue: null,
      decision: { sourceStatus: "succeeded" as const, reconciliationStatus: "not_required" as const, reportingDecision: "reportable" as const, postingStatus: "not_applicable" as const, blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
      stripeEvidence: {
        originalAmount: "50.42", originalCurrency: "USD", amountRefunded: "10.00", description: "Founding Membership renewal", sellerMessage: "Payment complete", cardholderName: "Stripe customer",
        settlementGrossAmount: "50.42", settlementFeeAmount: "1.75", settlementFeeTaxAmount: "0.18", settlementNetAmount: "48.67", settlementCurrency: "BHD", settlementExchangeRate: 0.376 as unknown as string, refunds: [{ refundId: "refund-1", originalAmount: "10.00", originalCurrency: "USD", settlementRefundAmount: "10.00", settlementCurrency: "BHD", settlementExchangeRate: "0.376" }],
      },
    };
    const snapshot: B2cDashboardSnapshot = {
      period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
      sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-12T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
      hasSourceRecords: true, eligiblePaymentsUsd: "$50.42", refundsUsd: "$10.00", netPaymentsUsd: "$40.42", completedSourcePaymentsUsd: "$50.42", sourceRefundsUsd: "$10.00",
      calculation: { completedSourcePaymentCount: 1, reportablePaymentCount: 1, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 1, eligibleRefundCount: 1, missingCustomerEmailCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
      reviewItems: 0, rows: [row],
    };

    const fetchMock = stubWorkspaceFetch([row], {
      "payment-evidence-1": {
        paymentId: "payment-evidence-1", source: "Stripe", sourceSystem: "stripe", providerReference: "ch_123", date: "Aug 9, 2026",
        stripeEvidence: row.stripeEvidence,
      },
    });
    render(<B2cOperations snapshot={snapshot} />);

    // The fourteen-column ledger and its per-row `View Stripe details` dialog
    // are removed (see "Remove" in the implementation plan's UI inventory).
    // The provider-supplied description is still shown directly in the ledger
    // (an Admin's explicit request); full Stripe settlement evidence moves
    // into the shared drawer's "Source evidence" section, which fetches it
    // from the dedicated Admin-only read rather than from the safe
    // `/api/b2c/workspace` payload.
    const table = await screen.findByRole("table", { name: "B2C ledger" });
    expect(within(table).queryByRole("columnheader", { name: "Source currency" })).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(within(table).getByText("Founding Membership renewal")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "View Stripe details" })).not.toBeInTheDocument();
    expect(within(table).getByText("Stripe customer")).toBeInTheDocument();
    // The pre-existing reportable metric remains the stored USD amount rather
    // than Stripe's separate BHD settlement/net-payout evidence.
    expect(screen.getAllByText("$50.42").length).toBeGreaterThan(0);

    fireEvent.click(within(table).getByRole("button", { name: "Review" }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/b2c/payments/payment-evidence-1/evidence", expect.anything()));
    expect(await within(dialog).findByText("Charge evidence")).toBeInTheDocument();
    expect(within(dialog).getByText("Stripe settlement evidence")).toBeInTheDocument();
    expect(within(dialog).getByText("48.67 BHD")).toBeInTheDocument();
    expect(within(dialog).getByText("refund-1")).toBeInTheDocument();
  });
});
