import type { B2cBlockingReason, B2cPaymentDecision } from "@/lib/b2c/payment-decision";

/**
 * One accurate B2C work item. Internal `queue` values stay detailed so each
 * record keeps its precise reason; the workspace UI only ever renders the
 * three `visibleGroup` filters plus `All`.
 */
export type B2cWorkItem = {
  id: string;
  recordId: string;
  recordKind: "provider_payment" | "provider_refund" | "finance_row" | "source_run";
  queue: "data_quality" | "duplicate" | "fx" | "reconciliation" | "source_failure";
  visibleGroup: "data" | "duplicates" | "reconciliation";
  financeMethod: "ios" | "bank_transfer" | null;
  title: string;
  explanation: string;
  financialImpactUsd: string | null;
  nextAction: "correct" | "convert_fx" | "choose_payment_duplicate" | "retry_source" | "review_exception";
  href: string;
};

/** A record whose decision may produce zero or more work items -- one per unresolved blocking reason. */
export type B2cWorkItemRecord = {
  id: string;
  recordKind: Exclude<B2cWorkItem["recordKind"], "source_run">;
  decision: B2cPaymentDecision;
  financeMethod: B2cWorkItem["financeMethod"];
  customerLabel: string;
  financialImpactUsd: string | null;
  href: string;
};

/** A retained source-sync failure that never went through a payment decision. */
export type B2cSourceFailureRecord = {
  id: string;
  provider: "stripe" | "tap";
  operationType: "reconciliation" | "historical_backfill";
  reason: string;
};

type ReasonPlan = {
  queue: B2cWorkItem["queue"];
  nextAction: B2cWorkItem["nextAction"];
  title: (customerLabel: string) => string;
  explanation: string;
};

/**
 * Reasons with no plan produce no work item: a failed or pending source
 * payment is retained, read-only, and not actionable from this workspace,
 * and a `manual_exclusion` reflects a decision that is already settled.
 */
const REASON_PLAN: Partial<Record<B2cBlockingReason, ReasonPlan>> = {
  missing_amount: {
    queue: "data_quality", nextAction: "correct",
    title: (name) => `Enter the missing amount for ${name}`,
    explanation: "This record has no available USD amount. Enter the verified value.",
  },
  missing_business_date: {
    queue: "data_quality", nextAction: "correct",
    title: (name) => `Enter the missing business date for ${name}`,
    explanation: "This record has no available business date. Enter the verified date.",
  },
  implausible_future_date: {
    queue: "data_quality", nextAction: "correct",
    title: (name) => `Correct the implausible date for ${name}`,
    explanation: "This record's business date has not happened yet. Verify the source and enter the correct date.",
  },
  missing_customer_email: {
    queue: "data_quality", nextAction: "correct",
    title: (name) => `Add the missing customer email for ${name}`,
    explanation: "This record has no customer email. Add a verified email or record an audited Finance exception.",
  },
  other_open_review: {
    queue: "data_quality", nextAction: "correct",
    title: (name) => `Resolve the open review item for ${name}`,
    explanation: "This record has an open follow-up review item.",
  },
  missing_fx: {
    queue: "fx", nextAction: "convert_fx",
    title: (name) => `Convert the foreign-currency amount for ${name}`,
    explanation: "This foreign-currency record needs a Finance-approved USD conversion.",
  },
  possible_duplicate: {
    queue: "duplicate", nextAction: "choose_payment_duplicate",
    title: (name) => `Choose the duplicate for ${name}`,
    explanation: "This record has an unresolved possible duplicate. Review both records and record one decision.",
  },
};

export function visibleGroupForQueue(queue: B2cWorkItem["queue"]): B2cWorkItem["visibleGroup"] {
  if (queue === "duplicate") return "duplicates";
  if (queue === "reconciliation" || queue === "source_failure") return "reconciliation";
  return "data";
}

/** Builds zero or more granular work items for one payment/finance-row record from its unresolved blocking reasons. */
export function buildB2cRecordWorkItems(record: B2cWorkItemRecord): B2cWorkItem[] {
  return record.decision.blockingReasons.flatMap((reason): B2cWorkItem[] => {
    const plan = REASON_PLAN[reason];
    if (!plan) return [];
    return [{
      id: `${record.id}:${reason}`,
      recordId: record.id,
      recordKind: record.recordKind,
      queue: plan.queue,
      visibleGroup: visibleGroupForQueue(plan.queue),
      financeMethod: record.financeMethod,
      title: plan.title(record.customerLabel),
      explanation: plan.explanation,
      financialImpactUsd: record.financialImpactUsd,
      nextAction: plan.nextAction,
      href: record.href,
    }];
  });
}

/** Builds the read-only work items surfacing a failed Stripe/Tap sync run. Never touches provider data. */
export function buildB2cSourceFailureWorkItems(runs: B2cSourceFailureRecord[]): B2cWorkItem[] {
  return runs.map((run) => {
    const params = new URLSearchParams({ tab: "sources", provider: run.provider });
    if (run.operationType === "historical_backfill") params.set("action", "backfill");
    return {
      id: `${run.id}:source_failure`,
      recordId: run.id,
      recordKind: "source_run",
      queue: "source_failure",
      visibleGroup: "reconciliation",
      financeMethod: null,
      title: `Retry the ${run.provider === "stripe" ? "Stripe" : "Tap"} sync`,
      explanation: run.reason,
      financialImpactUsd: null,
      nextAction: "retry_source",
      href: `/operations/b2c?${params.toString()}`,
    };
  });
}

/** Composes every granular work item into one list, grouped internally by domain, before UI filtering. */
export function buildB2cWorkItems(input: {
  records: B2cWorkItemRecord[];
  sourceFailures?: B2cSourceFailureRecord[];
}): B2cWorkItem[] {
  return [
    ...input.records.flatMap(buildB2cRecordWorkItems),
    ...buildB2cSourceFailureWorkItems(input.sourceFailures ?? []),
  ];
}
