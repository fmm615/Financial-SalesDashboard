import type { B2cBlockingReason, B2cPaymentDecision } from "@/lib/b2c/payment-decision";
import type { FinancePostingReadiness } from "@/server/services/b2c-finance-action-center";

/**
 * One accurate B2C work item. Internal `queue` values stay detailed so each
 * record keeps its precise reason; the workspace UI only ever renders the
 * four `visibleGroup` filters plus `All`.
 */
export type B2cWorkItem = {
  id: string;
  recordId: string;
  recordKind: "provider_payment" | "provider_refund" | "finance_row" | "provider_evidence" | "source_run";
  queue: "data_quality" | "duplicate" | "fx" | "mapping" | "reconciliation" | "ready_to_post" | "source_failure";
  visibleGroup: "data" | "duplicates" | "reconciliation" | "ready_to_post";
  financeMethod: "ios" | "bank_transfer" | null;
  title: string;
  explanation: string;
  financialImpactUsd: string | null;
  nextAction: "correct" | "map" | "convert_fx" | "choose_duplicate" | "compare" | "post" | "retry_source" | "review_exception" | "review_import_version";
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
  reason: string;
  href: string;
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
  unmapped_category: {
    queue: "mapping", nextAction: "map",
    title: (name) => `Map the product for ${name}`,
    explanation: "This record has no verified PLAYBOOK category. Map it to a category.",
  },
  missing_fx: {
    queue: "fx", nextAction: "convert_fx",
    title: (name) => `Convert the foreign-currency amount for ${name}`,
    explanation: "This foreign-currency record needs a Finance-approved USD conversion.",
  },
  possible_duplicate: {
    queue: "duplicate", nextAction: "choose_duplicate",
    title: (name) => `Choose the duplicate for ${name}`,
    explanation: "This record has an unresolved possible duplicate. Review both records and record one decision.",
  },
  unmatched_evidence: {
    queue: "reconciliation", nextAction: "compare",
    title: (name) => `Compare provider evidence for ${name}`,
    explanation: "Retained provider evidence does not match this record. Compare and resolve the mismatch.",
  },
  ambiguous_finance_lineage: {
    queue: "reconciliation", nextAction: "review_import_version",
    title: (name) => `Review the Payment Tracker version decision for ${name}`,
    explanation: "This Payment Tracker row needs an explicit new/revision/existing-payment decision.",
  },
};

export function visibleGroupForQueue(queue: B2cWorkItem["queue"]): B2cWorkItem["visibleGroup"] {
  if (queue === "duplicate") return "duplicates";
  if (queue === "reconciliation" || queue === "source_failure") return "reconciliation";
  if (queue === "ready_to_post") return "ready_to_post";
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
  return runs.map((run) => ({
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
    href: run.href,
  }));
}

/**
 * Builds the single aggregated Ready-to-post work item from Task 2's Finance
 * posting readiness summary. This never generates one item per lineage --
 * the workspace exposes exactly one `Post N Finance payments` action.
 */
export function buildB2cReadyToPostWorkItem(readiness: FinancePostingReadiness, href: string): B2cWorkItem | null {
  if (readiness.readyLineages === 0) return null;
  return {
    id: "ready-to-post",
    recordId: "ready-to-post",
    recordKind: "finance_row",
    queue: "ready_to_post",
    visibleGroup: "ready_to_post",
    financeMethod: null,
    title: `Post ${readiness.readyLineages} Finance payment${readiness.readyLineages === 1 ? "" : "s"}`,
    explanation: `${readiness.readyIosLineages} iOS and ${readiness.readyBankTransferLineages} bank transfer Finance rows are ready to post.`,
    financialImpactUsd: null,
    nextAction: "post",
    href,
  };
}

/** Composes every granular work item into one list, grouped internally by domain, before UI filtering. */
export function buildB2cWorkItems(input: {
  records: B2cWorkItemRecord[];
  sourceFailures?: B2cSourceFailureRecord[];
  postingReadiness?: FinancePostingReadiness;
  readyToPostHref?: string;
}): B2cWorkItem[] {
  const items = [
    ...input.records.flatMap(buildB2cRecordWorkItems),
    ...buildB2cSourceFailureWorkItems(input.sourceFailures ?? []),
  ];
  const readyToPost = input.postingReadiness ? buildB2cReadyToPostWorkItem(input.postingReadiness, input.readyToPostHref ?? "/operations/b2c?tab=work&queue=ready_to_post") : null;
  return readyToPost ? [...items, readyToPost] : items;
}
