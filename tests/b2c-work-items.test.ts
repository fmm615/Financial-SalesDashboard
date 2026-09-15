import { describe, expect, it } from "vitest";
import { resolveB2cPaymentDecision } from "@/lib/b2c/payment-decision";
import {
  buildB2cRecordWorkItems,
  buildB2cSourceFailureWorkItems,
  buildB2cWorkItems,
  visibleGroupForQueue,
  type B2cWorkItemRecord,
} from "@/server/services/b2c-work-items";
import { buildB2cWorkspaceOverview, chunkB2cWorkspaceQueryValues } from "@/server/repositories/b2c-workspace-repository";

const succeededBase = {
  sourceSystem: "stripe" as const,
  paymentStatus: "succeeded" as const,
  customerEmail: "member@example.com",
  occurredOn: "2026-08-01",
  openFlagTypes: new Set<string>(),
  amountUsd: "100",
  originalCurrency: "USD",
};

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
    const decision = resolveB2cPaymentDecision(succeededBase);
    expect(buildB2cRecordWorkItems(record({ decision }))).toEqual([]);
  });

  it("produces one data-quality item for a missing customer email", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, customerEmail: null });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "data_quality", visibleGroup: "data", nextAction: "correct", recordId: "payment-1" });
  });

  it("produces one duplicate work item for an unresolved possible duplicate", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, openFlagTypes: new Set(["possible_duplicate"]) });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "duplicate", visibleGroup: "duplicates", nextAction: "choose_payment_duplicate" });
  });

  it("produces no work item for a failed or pending source payment -- nothing is actionable in this workspace", () => {
    expect(buildB2cRecordWorkItems(record({ decision: resolveB2cPaymentDecision({ ...succeededBase, paymentStatus: "failed" }) }))).toEqual([]);
    expect(buildB2cRecordWorkItems(record({ decision: resolveB2cPaymentDecision({ ...succeededBase, paymentStatus: "pending" }) }))).toEqual([]);
  });

  it("produces no work item for an audited duplicate exclusion -- the decision is already settled", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, hasDuplicateExclusion: true });
    expect(buildB2cRecordWorkItems(record({ decision }))).toEqual([]);
  });

  it("produces one data-quality item for an implausible future business date, even on an already-posted Finance-tracker payment", () => {
    const decision = resolveB2cPaymentDecision({
      ...succeededBase, sourceSystem: "finance_tracker", occurredOn: "2026-11-01",
      isApprovedFinancePayment: true, financeLineageStatus: "posted",
    }, new Date("2026-08-20T00:00:00.000Z"));
    const items = buildB2cRecordWorkItems(record({ decision, customerLabel: "Hoor Alshubbar" }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "data_quality", visibleGroup: "data", nextAction: "correct", title: "Correct the implausible date for Hoor Alshubbar" });
  });

  it("produces an fx work item for a foreign-currency record awaiting conversion", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, originalCurrency: "BHD", amountUsd: null });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "fx", visibleGroup: "data", nextAction: "convert_fx" });
  });

  it("produces no work item for a retired unmapped-product flag -- category mapping no longer gates reportability", () => {
    const input = { ...succeededBase, openFlagTypes: new Set(["unmapped_product"]) };
    const decision = resolveB2cPaymentDecision(input);
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(decision.reportingDecision).toBe("reportable");
    expect(items).toEqual([]);
  });

  it("produces multiple work items when several valid blocking reasons are open at once", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, customerEmail: null, originalCurrency: "BHD", amountUsd: null });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items.map((item) => item.queue).sort()).toEqual(["data_quality", "fx"]);
  });

  it("produces a duplicate work item, not a second reportable payment, for a manual-bank candidate with an open possible duplicate", () => {
    const decision = resolveB2cPaymentDecision({
      ...succeededBase, sourceSystem: "manual_bank_transfer",
      openFlagTypes: new Set(["possible_duplicate"]),
    });
    const items = buildB2cRecordWorkItems(record({ id: "manual-1", decision, financeMethod: "bank_transfer" }));
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
    const items = buildB2cSourceFailureWorkItems([{ id: "run-1", provider: "stripe", reason: "The last Stripe sync failed.", href: "/operations/b2c?tab=sources" }]);
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
      href: "/operations/b2c?tab=sources",
    }]);
  });
});

describe("buildB2cWorkItems", () => {
  it("composes record items and source failures together", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, customerEmail: null });
    const items = buildB2cWorkItems({
      records: [record({ decision })],
      sourceFailures: [{ id: "run-1", provider: "tap", reason: "The last Tap sync failed.", href: "/operations/b2c?tab=sources" }],
    });
    expect(items.map((item) => item.queue).sort()).toEqual(["data_quality", "source_failure"]);
  });

  it("returns no items when nothing needs attention", () => {
    expect(buildB2cWorkItems({ records: [] })).toEqual([]);
  });
});

describe("buildB2cWorkspaceOverview", () => {
  it("summarizes ledger rows into the visible Work queue counts", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, customerEmail: null });
    const overview = buildB2cWorkspaceOverview({
      ledgerRows: [{
        id: "payment-1", recordType: "Payment", sourceSystem: "stripe", source: "Stripe",
        customerName: "Maya Al Khalifa", customerEmail: null, amountValueUsd: "100.00", decision,
      } as never],
    });
    expect(overview.counts).toMatchObject({ all: 1, data: 1 });
  });
});
