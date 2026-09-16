import { describe, expect, it } from "vitest";
import { presentB2cPaymentDecision, type B2cBlockingReason } from "@/lib/b2c/payment-decision";
import {
  buildB2cRecordWorkItems,
  buildB2cSourceFailureWorkItems,
  buildB2cWorkItems,
  visibleGroupForQueue,
  type B2cWorkItemRecord,
} from "@/server/services/b2c-work-items";
import { buildB2cWorkspaceOverview, chunkB2cWorkspaceQueryValues } from "@/server/repositories/b2c-workspace-repository";

// Mirrors b2c_payment_decision_reasons: missing_business_date and
// implausible_future_date are display-only and never gate reportability;
// every other blocking reason always co-occurs with a matching exclusion
// reason. Used here only to build internally-consistent fixtures -- the
// actual production code (buildB2cRecordWorkItems) reads blockingReasons
// only and never reportingDecision.
const BLOCKING_TO_EXCLUSION_REASON: Partial<Record<B2cBlockingReason, string>> = {
  missing_amount: "needs_fx_review",
  missing_fx: "needs_fx_review",
  missing_customer_email: "missing_customer_email",
  possible_duplicate: "possible_duplicate",
  duplicate_exclusion: "duplicate_exclusion",
  failed_payment: "not_succeeded",
  pending_payment: "not_succeeded",
  other_open_review: "needs_follow_up",
};

function decision(
  blockingReasons: B2cBlockingReason[] = [],
  overrides: {
    sourceStatus?: "succeeded" | "failed" | "pending";
    reportingDecision?: "reportable" | "blocked" | "excluded" | "exception_included";
    reconciliationStatus?: "not_required" | "duplicate_pending";
    postingStatus?: "not_applicable" | "posted";
    exclusionReasons?: string[];
  } = {},
) {
  const gatingExclusionReasons = [...new Set(blockingReasons.flatMap((reason) => BLOCKING_TO_EXCLUSION_REASON[reason] ?? []))];
  return presentB2cPaymentDecision({
    source_status: overrides.sourceStatus ?? "succeeded",
    reconciliation_status: overrides.reconciliationStatus ?? "not_required",
    reporting_decision: overrides.reportingDecision ?? (gatingExclusionReasons.length > 0 ? "blocked" : "reportable"),
    posting_status: overrides.postingStatus ?? "not_applicable",
    exclusion_reasons: overrides.exclusionReasons ?? gatingExclusionReasons,
    blocking_reasons: blockingReasons,
  });
}

function record(overrides: Partial<B2cWorkItemRecord> & { decision: B2cWorkItemRecord["decision"] }): B2cWorkItemRecord {
  return {
    id: "payment-1",
    recordKind: "provider_payment",
    financeMethod: null,
    customerLabel: "Maya Al Khalifa",
    financialImpactUsd: "100.00",
    href: "/operations/b2c?tab=work&record=payment-1",
    ...overrides,
  };
}

describe("visibleGroupForQueue", () => {
  it("groups FX and data-quality items under data", () => {
    expect(visibleGroupForQueue("fx")).toBe("data");
    expect(visibleGroupForQueue("data_quality")).toBe("data");
  });

  it("groups source failures and reconciliation under reconciliation", () => {
    expect(visibleGroupForQueue("source_failure")).toBe("reconciliation");
    expect(visibleGroupForQueue("reconciliation")).toBe("reconciliation");
  });

  it("keeps duplicates as their own group", () => {
    expect(visibleGroupForQueue("duplicate")).toBe("duplicates");
  });
});

describe("buildB2cRecordWorkItems", () => {
  it("produces no work item for a clean reportable payment", () => {
    expect(buildB2cRecordWorkItems(record({ decision: decision() }))).toEqual([]);
  });

  it("produces one data-quality item for a missing customer email", () => {
    const items = buildB2cRecordWorkItems(record({ decision: decision(["missing_customer_email"]) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "data_quality", visibleGroup: "data", nextAction: "correct", recordId: "payment-1" });
  });

  it("produces one duplicate work item for an unresolved possible duplicate", () => {
    const items = buildB2cRecordWorkItems(record({ decision: decision(["possible_duplicate"], { reconciliationStatus: "duplicate_pending" }) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "duplicate", visibleGroup: "duplicates", nextAction: "choose_payment_duplicate" });
  });

  it("produces no work item for a failed or pending source payment -- nothing is actionable in this workspace", () => {
    expect(buildB2cRecordWorkItems(record({ decision: decision(["failed_payment"], { sourceStatus: "failed" }) }))).toEqual([]);
    expect(buildB2cRecordWorkItems(record({ decision: decision(["pending_payment"], { sourceStatus: "pending" }) }))).toEqual([]);
  });

  it("produces no work item for an audited duplicate exclusion -- the decision is already settled", () => {
    expect(buildB2cRecordWorkItems(record({ decision: decision(["duplicate_exclusion"], { reportingDecision: "excluded" }) }))).toEqual([]);
  });

  it("produces one data-quality item for an implausible future business date, even on an already-posted Finance-tracker payment", () => {
    const items = buildB2cRecordWorkItems(record({
      decision: decision(["implausible_future_date"], { postingStatus: "posted" }),
      customerLabel: "Hoor Alshubbar",
    }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "data_quality", visibleGroup: "data", nextAction: "correct", title: "Correct the implausible date for Hoor Alshubbar" });
  });

  it("produces an fx work item for a foreign-currency record awaiting conversion", () => {
    const items = buildB2cRecordWorkItems(record({ decision: decision(["missing_fx"]) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "fx", visibleGroup: "data", nextAction: "convert_fx" });
  });

  it("produces no work item for a retired unmapped-product flag -- category mapping no longer gates reportability", () => {
    const sqlDecision = decision();
    const items = buildB2cRecordWorkItems(record({ decision: sqlDecision }));
    expect(sqlDecision.reportingDecision).toBe("reportable");
    expect(items).toEqual([]);
  });

  it("produces multiple work items when several valid blocking reasons are open at once", () => {
    const items = buildB2cRecordWorkItems(record({ decision: decision(["missing_fx", "missing_customer_email"]) }));
    expect(items.map((item) => item.queue).sort()).toEqual(["data_quality", "fx"]);
  });

  it("produces a duplicate work item, not a second reportable payment, for a manual-bank candidate with an open possible duplicate", () => {
    const items = buildB2cRecordWorkItems(record({
      id: "manual-1",
      decision: decision(["possible_duplicate"], { reconciliationStatus: "duplicate_pending" }),
      financeMethod: "bank_transfer",
    }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "duplicate", nextAction: "choose_payment_duplicate", recordId: "manual-1" });
  });
});

describe("chunkB2cWorkspaceQueryValues", () => {
  it("bounds large lookups below URL-size limits", () => {
    const batches = chunkB2cWorkspaceQueryValues(Array.from({ length: 20_000 }, (_, index) => `row-${index}`));
    expect(batches).toHaveLength(200);
    expect(batches.every((batch) => batch.length <= 100)).toBe(true);
    expect(batches.flat()).toHaveLength(20_000);
  });
});

describe("buildB2cSourceFailureWorkItems", () => {
  it("surfaces a failed sync run as a reconciliation-visible source_failure item without writing to the provider", () => {
    const items = buildB2cSourceFailureWorkItems([{ id: "run-1", provider: "stripe", operationType: "reconciliation", reason: "The last Stripe sync failed." }]);
    expect(items).toEqual([{
      id: "run-1:source_failure",
      recordId: "run-1",
      recordKind: "source_run",
      queue: "source_failure",
      visibleGroup: "reconciliation",
      financeMethod: null,
      title: "Retry the Stripe sync",
      explanation: "The last Stripe sync failed.",
      financialImpactUsd: null,
      nextAction: "retry_source",
      href: "/operations/b2c?tab=sources&provider=stripe",
    }]);
  });

  it("deep-links a failed historical backfill to the provider's expanded backfill controls", () => {
    const items = buildB2cSourceFailureWorkItems([{ id: "run-2", provider: "tap", operationType: "historical_backfill", reason: "The Tap backfill failed." }]);

    expect(items[0].href).toBe("/operations/b2c?tab=sources&provider=tap&action=backfill");
  });
});

describe("buildB2cWorkItems", () => {
  it("composes record items and source failures together", () => {
    const items = buildB2cWorkItems({
      records: [record({ decision: decision(["missing_customer_email"]) })],
      sourceFailures: [{ id: "run-1", provider: "tap", operationType: "reconciliation", reason: "The last Tap sync failed." }],
    });
    expect(items.map((item) => item.queue).sort()).toEqual(["data_quality", "source_failure"]);
  });

  it("returns no items when nothing needs attention", () => {
    expect(buildB2cWorkItems({ records: [] })).toEqual([]);
  });
});

describe("buildB2cWorkspaceOverview", () => {
  it("summarizes ledger rows into the visible Work queue counts", () => {
    const overview = buildB2cWorkspaceOverview({
      ledgerRows: [{
        id: "payment-1", recordType: "Payment", sourceSystem: "stripe", source: "Stripe",
        customerName: "Maya Al Khalifa", customerEmail: null, amountValueUsd: "100.00", decision: decision(["missing_customer_email"]),
      } as never],
    });
    expect(overview.counts).toMatchObject({ all: 1, data: 1 });
  });
});
