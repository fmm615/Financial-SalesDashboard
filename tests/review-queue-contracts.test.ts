import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createReviewQueueService,
  createReviewQueueMetrics,
  filterReviewQueueItems,
  toReviewQueueItem,
} from "@/server/services/review-queue";
import { reviewQueueListQuerySchema, reviewQueueNoteSchema } from "@/lib/validation/review-queue-contracts";
import { ReviewQueuePage } from "@/features/review-queue/review-queue-page";

const reviewQueueResponse = {
  ok: true,
  json: async () => ({
    items: [],
    metrics: { openCount: 0, resolvedThisMonthCount: 0, highPriorityOpenCount: 0 },
  }),
};

const b2cDuplicate = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceArea: "b2c_payment",
  sourceRecordId: "22222222-2222-4222-8222-222222222222",
  flagType: "possible_duplicate",
  status: "open",
  priority: 2,
  reason: "Matched source records",
  assignedTo: null,
  createdAt: "2026-08-10T09:00:00.000Z",
  resolvedAt: null,
} as const;

const historicalUnmappedProduct = {
  ...b2cDuplicate,
  id: "88888888-8888-4888-8888-888888888888",
  sourceRecordId: "99999999-9999-4999-8999-999999999999",
  flagType: "unmapped_product" as const,
  reason: "Historical product mapping evidence retained for audit.",
};

describe("Review Queue domain", () => {
  it("accepts only bounded queue filters and meaningful append-only notes", () => {
    expect(reviewQueueListQuerySchema.safeParse({ status: "all", flagType: "failed", priority: "2", query: "  source  " })).toMatchObject({
      success: true,
      data: { status: "all", flagType: "failed", priority: 2, query: "source" },
    });
    expect(reviewQueueListQuerySchema.safeParse({ priority: "6" }).success).toBe(false);
    expect(reviewQueueListQuerySchema.safeParse({ flagType: "unmapped_product" }).success).toBe(false);
    expect(reviewQueueNoteSchema.safeParse({ note: "  -  " }).success).toBe(false);
    expect(reviewQueueNoteSchema.safeParse({ note: "Verified source reference with Finance" })).toMatchObject({
      success: true,
      data: { note: "Verified source reference with Finance" },
    });
    expect(reviewQueueNoteSchema.safeParse({ note: "Valid note", status: "resolved" }).success).toBe(false);
  });

  it("does not offer retired product mapping flags in the live filter", async () => {
    const fetchMock = vi.fn(async () => reviewQueueResponse);
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(React.createElement(ReviewQueuePage));

      expect(await screen.findByRole("option", { name: "Possible duplicate" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "Unmapped product" })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends an open B2C possible duplicate to its corresponding B2C work item", () => {
    expect(toReviewQueueItem(b2cDuplicate)).toMatchObject({
      sourceLabel: "B2C payment · 22222222-2222-4222-8222-222222222222",
      flagLabel: "Possible duplicate",
      nextAction: { kind: "navigate", href: "/operations/b2c?tab=work&record=22222222-2222-4222-8222-222222222222", label: "Open B2C work item" },
    });
  });

  it("sends an open B2B possible duplicate to its existing dedicated review", () => {
    expect(toReviewQueueItem({
      ...b2cDuplicate,
      sourceArea: "b2b_deal",
      sourceRecordId: "33333333-3333-4333-8333-333333333333",
    })).toMatchObject({
      nextAction: { kind: "navigate", href: "/admin", label: "Open B2B duplicate review" },
    });
  });

  it("filters by status, type, priority, and source text without using financial values", () => {
    const resolvedRefund = toReviewQueueItem({
      ...b2cDuplicate,
      id: "44444444-4444-4444-8444-444444444444",
      sourceArea: "b2c_refund",
      sourceRecordId: "55555555-5555-4555-8555-555555555555",
      flagType: "refunded",
      status: "resolved",
      priority: 4,
      reason: "Refund reason recorded",
      resolvedAt: "2026-08-11T09:00:00.000Z",
    });

    expect(filterReviewQueueItems([toReviewQueueItem(b2cDuplicate), resolvedRefund], {
      status: "resolved", flagType: "refunded", priority: 4, query: "55555555",
    })).toEqual([resolvedRefund]);
  });

  it("counts closures by resolution date and leaves unresolved duplicate flags visible", () => {
    const resolvedInMonth = toReviewQueueItem({
      ...b2cDuplicate,
      id: "66666666-6666-4666-8666-666666666666",
      status: "resolved",
      priority: 3,
      createdAt: "2026-07-30T09:00:00.000Z",
      resolvedAt: "2026-08-02T09:00:00.000Z",
    });
    const resolvedLastMonth = toReviewQueueItem({
      ...resolvedInMonth,
      id: "77777777-7777-4777-8777-777777777777",
      resolvedAt: "2026-07-31T09:00:00.000Z",
    });

    expect(createReviewQueueMetrics([toReviewQueueItem(b2cDuplicate), resolvedInMonth, resolvedLastMonth], new Date("2026-08-15T00:00:00.000Z"))).toEqual({
      openCount: 1,
      resolvedThisMonthCount: 1,
      highPriorityOpenCount: 1,
    });
  });

  it("returns filtered live items and derived metrics without exposing raw database fields", async () => {
    const service = createReviewQueueService({
      listFlags: async () => [b2cDuplicate],
      getFlagDetail: async () => null,
    }, () => new Date("2026-08-15T00:00:00.000Z"));

    await expect(service.list({ status: "open" })).resolves.toEqual({
      items: [toReviewQueueItem(b2cDuplicate)],
      metrics: { openCount: 1, resolvedThisMonthCount: 0, highPriorityOpenCount: 1 },
    });
  });

  it("excludes retained unmapped-product flags from live items and metrics", async () => {
    const service = createReviewQueueService({
      listFlags: async () => [historicalUnmappedProduct, b2cDuplicate],
      getFlagDetail: async () => null,
    }, () => new Date("2026-08-15T00:00:00.000Z"));

    await expect(service.list({ status: "all" })).resolves.toEqual({
      items: [toReviewQueueItem(b2cDuplicate)],
      metrics: { openCount: 1, resolvedThisMonthCount: 0, highPriorityOpenCount: 1 },
    });
  });

  it("keeps an exact retained unmapped-product flag readable as review detail", async () => {
    const service = createReviewQueueService({
      listFlags: async () => [],
      getFlagDetail: async () => ({ flag: historicalUnmappedProduct, resolutions: [], notes: [] }),
    });

    await expect(service.detail(historicalUnmappedProduct.id)).resolves.toEqual({
      item: toReviewQueueItem(historicalUnmappedProduct),
      resolutions: [],
      notes: [],
    });
  });
});
