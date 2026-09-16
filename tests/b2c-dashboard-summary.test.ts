import { describe, expect, it, vi } from "vitest";
import {
  getB2cDashboardSnapshot,
  getB2cDashboardSummary,
} from "@/server/repositories/b2c-dashboard-repository";

function fullSnapshotClientWithSqlDecision(decision: Record<string, unknown>) {
  const payment = {
    id: "90000000-0000-4000-8000-000000000001",
    source_system: "stripe",
    provider_transaction_id: "ch_sql_authority",
    customer_name: "SQL Authority",
    customer_email: "clean@example.com",
    customer_phone: null,
    category_code: "membership",
    membership_tier: "Annual",
    payment_status: "succeeded",
    original_amount: "100.000000",
    original_currency: "USD",
    amount_usd: "100.000000",
    occurred_on: "2026-09-10",
    occurred_at: "2026-09-10T12:00:00.000Z",
    source_metadata: {},
  };
  const rowsByTable: Record<string, unknown[]> = {
    b2c_payments: [payment],
    b2c_refunds: [],
    review_flags: [],
    b2c_payment_local_overrides: [],
    b2c_payment_fx_conversions: [],
    b2c_refund_fx_conversions: [],
    b2c_payment_finance_exception_decisions: [],
    integration_sync_runs: [],
  };
  const queryFor = (table: string) => {
    const result = { data: rowsByTable[table] ?? [], error: null };
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  };

  return {
    from: (table: string) => queryFor(table),
    rpc: async (name: string) => ({
      data: name === "get_b2c_ledger_decisions"
        ? [{ record_type: "Payment", record_id: payment.id, decision }]
        : [],
      error: null,
    }),
  };
}

describe("getB2cDashboardSummary", () => {
  it("maps the database aggregate without recomputing financial decisions from source rows", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        has_source_records: true,
        eligible_payments_usd: "712.345600",
        refunds_usd: "12.340000",
        net_payments_usd: "700.005600",
        completed_source_payments_usd: "900.000000",
        source_refunds_usd: "15.000000",
        calculation: {
          completed_source_payment_count: 11,
          reportable_payment_count: 7,
          excluded_completed_payment_count: 4,
          excluded_completed_payments_usd: "187.654400",
          source_refund_count: 3,
          eligible_refund_count: 2,
          missing_customer_email_count: 1,
          possible_duplicate_count: 2,
          other_review_count: 1,
          non_succeeded_payment_count: 5,
          finance_exception_payment_count: 1,
        },
        review_items: 6,
        source_coverage_inputs: {
          providers: [{
            provider: "stripe",
            active: true,
            historicalBackfill: { status: "completed", recordsFailed: 0, completedAt: "2026-08-31T23:59:00.000Z" },
            latestReconciliation: { status: "completed", requestedRangeEnd: "2026-09-30", completedAt: "2026-10-01T01:00:00.000Z" },
          }, {
            provider: "tap",
            active: false,
            historicalBackfill: null,
            latestReconciliation: null,
          }],
        },
      },
      error: null,
    });
    const client = { rpc } as never;

    const summary = await getB2cDashboardSummary(
      client,
      new Date("2026-09-16T10:00:00.000Z"),
      "2026-09",
    );

    expect(summary).toMatchObject({
      period: { month: "2026-09", monthStart: "2026-09-01", monthEnd: "2026-09-30" },
      hasSourceRecords: true,
      eligiblePaymentsUsd: "$712.34",
      refundsUsd: "$12.34",
      netPaymentsUsd: "$700.00",
      completedSourcePaymentsUsd: "$900.00",
      sourceRefundsUsd: "$15.00",
      calculation: {
        reportablePaymentCount: 7,
        excludedCompletedPaymentsUsd: "$187.65",
        financeExceptionPaymentCount: 1,
      },
      reviewItems: 6,
      rows: [],
      sourceCoverage: {
        reportingTotalsReady: true,
        state: "ready",
        dataAsOf: "2026-09-30",
      },
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_b2c_dashboard_summary", {
      p_period: "2026-09",
      p_today: "2026-09-16",
    });
  });

  it("rejects a malformed aggregate instead of silently substituting zeroes", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: { eligible_payments_usd: null }, error: null }),
    } as never;

    await expect(getB2cDashboardSummary(client, new Date("2026-09-16T00:00:00.000Z"), "all"))
      .rejects.toThrow(/invalid B2C dashboard summary/i);
  });

  it("uses SQL-produced reasons even when clean source facts would imply reportability in TypeScript", async () => {
    const snapshot = await getB2cDashboardSnapshot(
      fullSnapshotClientWithSqlDecision({
        source_status: "succeeded",
        reconciliation_status: "not_required",
        reporting_decision: "blocked",
        posting_status: "not_applicable",
        exclusion_reasons: ["missing_customer_email"],
        blocking_reasons: ["missing_customer_email"],
      }) as never,
      new Date("2026-09-16T00:00:00.000Z"),
      "2026-09",
    );

    expect(snapshot.eligiblePaymentsUsd).toBe("$0.00");
    expect(snapshot.calculation).toMatchObject({
      reportablePaymentCount: 0,
      excludedCompletedPaymentCount: 1,
      missingCustomerEmailCount: 1,
    });
  });
});
