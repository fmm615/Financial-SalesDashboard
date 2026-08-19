import { describe, expect, it } from "vitest";
import { resolveB2cPaymentDecision } from "@/lib/b2c/payment-decision";
import {
  buildB2cReadyToPostWorkItem,
  buildB2cRecordWorkItems,
  buildB2cSourceFailureWorkItems,
  buildB2cWorkItems,
  visibleGroupForQueue,
  type B2cWorkItemRecord,
} from "@/server/services/b2c-work-items";

const succeededBase = {
  sourceSystem: "stripe" as const,
  paymentStatus: "succeeded" as const,
  customerEmail: "member@example.com",
  categoryCode: "membership",
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
  it("groups FX and mapping under data", () => {
    expect(visibleGroupForQueue("fx")).toBe("data");
    expect(visibleGroupForQueue("mapping")).toBe("data");
    expect(visibleGroupForQueue("data_quality")).toBe("data");
  });

  it("groups source failures and provider mismatches under reconciliation", () => {
    expect(visibleGroupForQueue("source_failure")).toBe("reconciliation");
    expect(visibleGroupForQueue("reconciliation")).toBe("reconciliation");
  });

  it("keeps duplicates and ready-to-post as their own groups", () => {
    expect(visibleGroupForQueue("duplicate")).toBe("duplicates");
    expect(visibleGroupForQueue("ready_to_post")).toBe("ready_to_post");
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
    expect(items[0]).toMatchObject({ queue: "duplicate", visibleGroup: "duplicates", nextAction: "choose_duplicate" });
  });

  it("produces no work item for a failed or pending source payment -- nothing is actionable in this workspace", () => {
    expect(buildB2cRecordWorkItems(record({ decision: resolveB2cPaymentDecision({ ...succeededBase, paymentStatus: "failed" }) }))).toEqual([]);
    expect(buildB2cRecordWorkItems(record({ decision: resolveB2cPaymentDecision({ ...succeededBase, paymentStatus: "pending" }) }))).toEqual([]);
  });

  it("produces no work item for an explicit manual exclusion -- the decision is already settled", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, hasManualExclusion: true });
    expect(buildB2cRecordWorkItems(record({ decision }))).toEqual([]);
  });

  it("produces an fx work item for a foreign-currency record awaiting conversion", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, originalCurrency: "BHD", amountUsd: null });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "fx", visibleGroup: "data", nextAction: "convert_fx" });
  });

  it("produces a mapping work item for an unmapped category", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, categoryCode: "unmapped" });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "mapping", visibleGroup: "data", nextAction: "map" });
  });

  it("produces a reconciliation work item for unmatched provider evidence", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, evidenceMatchState: "unmatched" });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "reconciliation", visibleGroup: "reconciliation", nextAction: "compare" });
  });

  it("produces a reconciliation work item for an ambiguous Finance lineage needing an import-version decision", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, sourceSystem: "finance_tracker", financeLineageStatus: "ambiguous" });
    const items = buildB2cRecordWorkItems(record({ decision, recordKind: "finance_row", financeMethod: "ios" }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "reconciliation", nextAction: "review_import_version", financeMethod: "ios" });
  });

  it("produces multiple work items when several blocking reasons are open at once", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, customerEmail: null, categoryCode: "unmapped" });
    const items = buildB2cRecordWorkItems(record({ decision }));
    expect(items.map((item) => item.queue).sort()).toEqual(["data_quality", "mapping"]);
  });

  it("gives an iOS tracker row and a bank-transfer tracker row their own distinct finance method label", () => {
    const iosDecision = resolveB2cPaymentDecision({ ...succeededBase, sourceSystem: "finance_tracker", customerEmail: null, financeLineageStatus: "not_ready" });
    const iosItems = buildB2cRecordWorkItems(record({ id: "finance-ios-1", decision: iosDecision, recordKind: "finance_row", financeMethod: "ios" }));
    expect(iosItems[0]).toMatchObject({ financeMethod: "ios", recordId: "finance-ios-1" });

    const bankDecision = resolveB2cPaymentDecision({ ...succeededBase, sourceSystem: "finance_tracker", customerEmail: null, financeLineageStatus: "not_ready" });
    const bankItems = buildB2cRecordWorkItems(record({ id: "finance-bank-1", decision: bankDecision, recordKind: "finance_row", financeMethod: "bank_transfer" }));
    expect(bankItems[0]).toMatchObject({ financeMethod: "bank_transfer", recordId: "finance-bank-1" });
  });

  it("produces a duplicate work item, not a second reportable payment, for a manual-bank candidate matching an existing tracker lineage", () => {
    const decision = resolveB2cPaymentDecision({
      ...succeededBase, sourceSystem: "manual_bank_transfer",
      openFlagTypes: new Set(["possible_duplicate"]), financeLineageStatus: "not_ready",
    });
    const items = buildB2cRecordWorkItems(record({ id: "manual-1", decision, financeMethod: "bank_transfer" }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ queue: "duplicate", nextAction: "choose_duplicate", recordId: "manual-1" });
    expect(items.some((item) => item.queue === "ready_to_post")).toBe(false);
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

describe("buildB2cReadyToPostWorkItem", () => {
  it("returns null when nothing is ready to post", () => {
    expect(buildB2cReadyToPostWorkItem({ readyLineages: 0, readyIosLineages: 0, readyBankTransferLineages: 0, alreadyPostedLineages: 3, blockedRows: 1, ambiguousRows: 0 }, "/href")).toBeNull();
  });

  it("aggregates ready lineages into exactly one item instead of one Post button per row", () => {
    const item = buildB2cReadyToPostWorkItem({ readyLineages: 3, readyIosLineages: 2, readyBankTransferLineages: 1, alreadyPostedLineages: 0, blockedRows: 0, ambiguousRows: 0 }, "/operations/b2c?tab=work&queue=ready_to_post");
    expect(item).toMatchObject({ queue: "ready_to_post", visibleGroup: "ready_to_post", nextAction: "post", title: "Post 3 Finance payments" });
  });
});

describe("buildB2cWorkItems", () => {
  it("composes record items, source failures, and the aggregate ready-to-post item together", () => {
    const decision = resolveB2cPaymentDecision({ ...succeededBase, customerEmail: null });
    const items = buildB2cWorkItems({
      records: [record({ decision })],
      sourceFailures: [{ id: "run-1", provider: "tap", reason: "The last Tap sync failed.", href: "/operations/b2c?tab=sources" }],
      postingReadiness: { readyLineages: 1, readyIosLineages: 1, readyBankTransferLineages: 0, alreadyPostedLineages: 0, blockedRows: 0, ambiguousRows: 0 },
    });
    expect(items.map((item) => item.queue).sort()).toEqual(["data_quality", "ready_to_post", "source_failure"]);
  });

  it("omits the ready-to-post item entirely when nothing is ready", () => {
    const items = buildB2cWorkItems({ records: [], postingReadiness: { readyLineages: 0, readyIosLineages: 0, readyBankTransferLineages: 0, alreadyPostedLineages: 0, blockedRows: 0, ambiguousRows: 0 } });
    expect(items).toEqual([]);
  });
});
