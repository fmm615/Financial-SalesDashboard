export type ReviewQueueStatus = "open" | "resolved" | "dismissed";

export type ReviewQueueFlagType = "refunded" | "failed" | "possible_duplicate" | "unmapped_product" | "needs_follow_up" | "needs_fx_review";

export type ReviewQueueFlagRecord = {
  id: string;
  sourceArea: string;
  sourceRecordId: string;
  flagType: ReviewQueueFlagType;
  status: ReviewQueueStatus;
  priority: number;
  reason: string;
  assignedTo: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type ReviewQueueNextAction =
  | { kind: "navigate"; href: string; label: string }
  | { kind: "note_only"; label: string };

export type ReviewQueueItem = ReviewQueueFlagRecord & {
  flagLabel: string;
  sourceLabel: string;
  nextAction: ReviewQueueNextAction;
};

export type ReviewQueueFilters = {
  status: ReviewQueueStatus | "all";
  flagType?: ReviewQueueFlagType;
  priority?: number;
  query?: string;
};

export type ReviewQueueMetrics = {
  openCount: number;
  resolvedThisMonthCount: number;
  highPriorityOpenCount: number;
};

export type ReviewQueueResolutionRecord = {
  resolutionStatus: Exclude<ReviewQueueStatus, "open">;
  resolutionNote: string;
  createdBy: string;
  createdAt: string;
};

export type ReviewQueueNoteRecord = {
  id: string;
  note: string;
  createdBy: string;
  createdAt: string;
};

export type ReviewQueueDetailRecord = {
  flag: ReviewQueueFlagRecord;
  resolutions: ReviewQueueResolutionRecord[];
  notes: ReviewQueueNoteRecord[];
};

export type ReviewQueueDetail = {
  item: ReviewQueueItem;
  resolutions: ReviewQueueResolutionRecord[];
  notes: ReviewQueueNoteRecord[];
};

export type ReviewQueueRepository = {
  listFlags(): Promise<ReviewQueueFlagRecord[]>;
  getFlagDetail(flagId: string): Promise<ReviewQueueDetailRecord | null>;
};

const flagLabels: Record<ReviewQueueFlagType, string> = {
  refunded: "Refunded",
  failed: "Failed",
  possible_duplicate: "Possible duplicate",
  unmapped_product: "Unmapped product",
  needs_follow_up: "Needs follow-up",
  needs_fx_review: "Needs FX review",
};

const sourceLabels: Record<string, string> = {
  b2c_payment: "B2C payment",
  b2c_refund: "B2C refund",
  b2b_deal: "B2B deal",
  b2b_booking: "B2B booking",
  b2b_recognised_sale: "B2B recognised sale",
  product_mapping: "Product mapping",
  integration: "Integration",
};

/**
 * B2C work items live in exactly one place: the `/operations/b2c` Work queue.
 * Every B2C-sourced flag deep-links to its corresponding work item there
 * instead of exposing a second, Review-Queue-local mutation surface.
 */
function b2cWorkItemHref(sourceRecordId: string): string {
  return `/operations/b2c?tab=work&record=${sourceRecordId}`;
}

function getNextAction(sourceArea: string, flagType: ReviewQueueFlagType, sourceRecordId: string): ReviewQueueNextAction {
  if (sourceArea === "b2b_deal" && flagType === "possible_duplicate") {
    return { kind: "navigate", href: "/admin", label: "Open B2B duplicate review" };
  }
  if (sourceArea === "b2c_payment" || sourceArea === "b2c_refund" || sourceArea === "product_mapping") {
    return { kind: "navigate", href: b2cWorkItemHref(sourceRecordId), label: "Open B2C work item" };
  }
  if (sourceArea.startsWith("b2b_")) {
    return { kind: "navigate", href: "/operations/b2b", label: "Open B2B Operations" };
  }
  if (sourceArea === "integration") {
    return { kind: "navigate", href: "/admin", label: "Open Administration" };
  }
  return { kind: "note_only", label: "Review source details" };
}

export function toReviewQueueItem(flag: ReviewQueueFlagRecord): ReviewQueueItem {
  const sourceLabel = sourceLabels[flag.sourceArea] ?? "Review source";
  return {
    ...flag,
    flagLabel: flagLabels[flag.flagType],
    sourceLabel: `${sourceLabel} · ${flag.sourceRecordId}`,
    nextAction: getNextAction(flag.sourceArea, flag.flagType, flag.sourceRecordId),
  };
}

export function filterReviewQueueItems(items: ReviewQueueItem[], filters: ReviewQueueFilters): ReviewQueueItem[] {
  const query = filters.query?.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.status !== "all" && item.status !== filters.status) return false;
    if (filters.flagType && item.flagType !== filters.flagType) return false;
    if (filters.priority && item.priority !== filters.priority) return false;
    if (!query) return true;
    return [item.flagLabel, item.sourceLabel, item.sourceArea, item.sourceRecordId, item.reason]
      .some((value) => value.toLowerCase().includes(query));
  });
}

export function createReviewQueueMetrics(items: ReviewQueueItem[], now: Date): ReviewQueueMetrics {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    openCount: items.filter((item) => item.status === "open").length,
    resolvedThisMonthCount: items.filter((item) => {
      if (item.status === "open" || !item.resolvedAt) return false;
      const resolvedAt = new Date(item.resolvedAt);
      return resolvedAt.getUTCFullYear() === year && resolvedAt.getUTCMonth() === month;
    }).length,
    highPriorityOpenCount: items.filter((item) => item.status === "open" && item.priority <= 2).length,
  };
}

export function createReviewQueueService(repository: ReviewQueueRepository, now: () => Date = () => new Date()) {
  return {
    async list(filters: ReviewQueueFilters): Promise<{ items: ReviewQueueItem[]; metrics: ReviewQueueMetrics }> {
      const items = filterReviewQueueItems((await repository.listFlags()).map(toReviewQueueItem), filters);
      return { items, metrics: createReviewQueueMetrics(items, now()) };
    },
    async detail(flagId: string): Promise<ReviewQueueDetail | null> {
      const detail = await repository.getFlagDetail(flagId);
      if (!detail) return null;
      return { item: toReviewQueueItem(detail.flag), resolutions: detail.resolutions, notes: detail.notes };
    },
  };
}
