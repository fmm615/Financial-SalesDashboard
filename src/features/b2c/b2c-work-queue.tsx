"use client";

import { EmptyState, SectionCard } from "@/components/ui";
import { B2cApprovedFinancePosting } from "@/features/b2c/b2c-approved-finance-posting";
import type { B2cWorkspaceCounts, B2cWorkspaceOverview } from "@/server/repositories/b2c-workspace-repository";
import type { B2cWorkItem } from "@/server/services/b2c-work-items";

export type B2cWorkQueueFilter = keyof B2cWorkspaceCounts;

const QUEUE_CHIPS: Array<{ value: B2cWorkQueueFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "data", label: "Data" },
  { value: "duplicates", label: "Duplicates" },
  { value: "reconciliation", label: "Reconciliation" },
  { value: "ready_to_post", label: "Ready to post" },
];

const NEXT_ACTION_LABEL: Record<B2cWorkItem["nextAction"], string> = {
  correct: "Correct",
  map: "Map product",
  convert_fx: "Convert FX",
  choose_duplicate: "Choose duplicate",
  compare: "Compare evidence",
  post: "Post",
  retry_source: "Open Sources",
  review_exception: "Review exception",
  review_import_version: "Review import version",
};

function WorkItemRow({ item, onOpen }: { item: B2cWorkItem; onOpen: (item: B2cWorkItem) => void }) {
  return <li className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0">
      <p className="font-medium text-text-primary">{item.title}</p>
      <p className="mt-1 text-sm leading-6 text-text-muted">{item.explanation}</p>
      {item.financialImpactUsd && <p className="mt-1 text-sm font-medium tabular-nums text-text-secondary">{item.financialImpactUsd}</p>}
    </div>
    {/* Exactly one primary action per work item. */}
    <button type="button" onClick={() => onOpen(item)} className="min-h-11 shrink-0 rounded-pill bg-brand-primary px-4 text-sm font-semibold text-white hover:opacity-90">
      {NEXT_ACTION_LABEL[item.nextAction]}
    </button>
  </li>;
}

/**
 * The Work queue is the sole owner of prioritizing exceptional B2C records.
 * Five visible filters map directly to Task 3's `visibleGroup`; each item
 * shows exactly one primary next action. The aggregated ready-to-post item
 * renders Task 2's one Ready-to-post container instead of a generic row, so
 * the posting panel is never nested inside another posting card.
 */
export function B2cWorkQueue({ overview, activeQueue, onSelectQueue, onOpenItem, onPosted }: {
  overview: B2cWorkspaceOverview;
  activeQueue: B2cWorkQueueFilter;
  onSelectQueue: (queue: B2cWorkQueueFilter) => void;
  onOpenItem: (item: B2cWorkItem) => void;
  onPosted: () => Promise<void>;
}) {
  const items = overview.items.filter((item) => item.visibleGroup !== "ready_to_post" && (activeQueue === "all" || item.visibleGroup === activeQueue));
  const readyToPostItem = overview.items.find((item) => item.nextAction === "post");
  const showReadyToPostPanel = readyToPostItem && (activeQueue === "all" || activeQueue === "ready_to_post");

  return <SectionCard title="Work queue" description="Prioritized B2C records needing an Admin decision. Choose a filter, then take the one action shown for each item.">
    <div role="group" aria-label="Work queue filters" className="flex flex-wrap gap-2">
      {QUEUE_CHIPS.map((chip) => <button
        key={chip.value} type="button" aria-pressed={activeQueue === chip.value}
        onClick={() => onSelectQueue(chip.value)}
        className={`min-h-11 rounded-pill border px-4 text-sm font-medium transition-colors ${activeQueue === chip.value ? "border-brand-primary bg-brand-primary text-white" : "border-border bg-surface text-text-secondary hover:border-brand-accent/40"}`}
      >
        {chip.label} <span className="ml-1 tabular-nums opacity-80">{overview.counts[chip.value]}</span>
      </button>)}
    </div>

    <div className="mt-5 space-y-3">
      {showReadyToPostPanel && <div>
        <p className="mb-2 text-sm leading-6 text-text-muted">{readyToPostItem.explanation}</p>
        <B2cApprovedFinancePosting onPosted={onPosted} />
      </div>}
      {items.length === 0 && !showReadyToPostPanel && <EmptyState title="No work items in this filter" description="Nothing in this group needs an Admin decision right now." />}
      {items.length > 0 && <ul className="space-y-3">{items.map((item) => <WorkItemRow key={item.id} item={item} onOpen={onOpenItem} />)}</ul>}
    </div>
  </SectionCard>;
}
