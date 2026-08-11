import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { RoleProvider } from "@/lib/auth/role-context";
import { B2bOperations } from "@/features/b2b/b2b-operations";
import { ReportsPage } from "@/features/reports/reports-page";
import { ReviewQueuePage } from "@/features/review-queue/review-queue-page";

vi.mock("next/navigation", () => ({ usePathname: () => "/executive", useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/components/charts", () => ({ BreakdownChart: () => <div aria-label="Breakdown chart" /> }));

const REVIEW_FLAG_ID = "11111111-1111-4111-8111-111111111111";

const reviewQueueItem = {
  id: REVIEW_FLAG_ID,
  sourceArea: "b2c_payment",
  sourceRecordId: REVIEW_FLAG_ID,
  flagType: "possible_duplicate",
  status: "open",
  priority: 1,
  reason: "Matched source records require an explicit Finance decision.",
  assignedTo: null,
  createdAt: "2026-08-10T09:00:00.000Z",
  resolvedAt: null,
  flagLabel: "Possible duplicate",
  sourceLabel: `B2C payment · ${REVIEW_FLAG_ID}`,
  nextAction: { kind: "note_only", label: "Duplicate decision required" },
} as const;

describe("role-aware presentation", () => {
  it("does not render manual B2B entry for a Viewer", () => {
    render(<RoleProvider role="viewer"><B2bOperations /></RoleProvider>);
    expect(screen.queryByRole("button", { name: "Add manual B2B deal" })).not.toBeInTheDocument();
  });

  it("keeps the report archive while hiding report generation from a Viewer", () => {
    render(<RoleProvider role="viewer"><ReportsPage /></RoleProvider>);
    expect(screen.queryByRole("button", { name: "Generate report" })).not.toBeInTheDocument();
    expect(screen.getAllByText("PDF").length).toBeGreaterThan(0);
  });

  it("shows live review history without an Admin note control for a Viewer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes(`/api/review-queue/${REVIEW_FLAG_ID}`)) {
        return { ok: true, json: async () => ({ item: {
          item: reviewQueueItem,
          resolutions: [{
            resolutionStatus: "dismissed",
            resolutionNote: "Earlier review retained for audit.",
            createdBy: "Finance Admin",
            createdAt: "2026-08-09T09:00:00.000Z",
          }],
          notes: [{
            id: "33333333-3333-4333-8333-333333333333",
            note: "Awaiting the final B2C duplicate workflow.",
            createdBy: "Finance Admin",
            createdAt: "2026-08-10T10:00:00.000Z",
          }],
        } }) };
      }
      return { ok: true, json: async () => ({
        items: [reviewQueueItem],
        metrics: { openCount: 1, resolvedThisMonthCount: 0, highPriorityOpenCount: 1 },
      }) };
    }));

    try {
      render(<RoleProvider role="viewer"><ReviewQueuePage /></RoleProvider>);
      expect(await screen.findByText(`B2C payment · ${REVIEW_FLAG_ID}`)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Possible duplicate.*B2C payment/ }));

      expect(await screen.findByText("Earlier review retained for audit.")).toBeInTheDocument();
      expect(screen.getByText("Awaiting the final B2C duplicate workflow.")).toBeInTheDocument();
      expect(screen.getByText(/Only an Admin can add a note/)).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Add review note" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Mark as reviewed" })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
