import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { ExecutiveDashboard } from "@/features/executive/executive-dashboard";
import { B2bOperations } from "@/features/b2b/b2b-operations";
import { ReportsPage } from "@/features/reports/reports-page";
import { ReviewQueuePage } from "@/features/review-queue/review-queue-page";
import { EmptyState, LoadingSkeleton, NotBackfilledState, TableCell } from "@/components/ui";

vi.mock("next/navigation", () => ({ usePathname: () => "/executive", useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/components/charts", () => ({ SalesTrendChart: () => <div aria-label="Sales trend chart" />, BreakdownChart: () => <div aria-label="Breakdown chart" /> }));

describe("UI foundation", () => {
  it("renders scalable main navigation and executive essentials", () => {
    render(<ExecutiveDashboard />);
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Executive" })).toBeInTheDocument();
    expect(screen.getByText("Sales this month")).toBeInTheDocument();
    expect(screen.getByText("B2B bookings")).toBeInTheDocument();
    expect(screen.getByText("Year-to-date progress")).toBeInTheDocument();
    expect(screen.getByText("Historical expense trends not loaded")).toBeInTheDocument();
  });

  it("provides required neutral data states", () => {
    render(<><LoadingSkeleton rows={2} /><EmptyState title="Nothing to review" /><NotBackfilledState /></>);
    expect(screen.getByLabelText("Loading data")).toBeInTheDocument();
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
    expect(screen.getByText("Historical data not available")).toBeInTheDocument();
  });

  it("passes native table-cell attributes through to the rendered cell", () => {
    render(<table><tbody><tr><TableCell colSpan={2}>Loading archive</TableCell></tr></tbody></table>);

    expect(screen.getByText("Loading archive")).toHaveAttribute("colspan", "2");
  });

  it("opens a review detail drawer and shows duplicate records side by side", () => {
    render(<ReviewQueuePage />);
    fireEvent.click(screen.getByText("Potential repeated membership payment"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Related records")).toBeInTheDocument();
    expect(screen.getByText(/Stripe pi_3NC/)).toBeInTheDocument();
  });

  it("keeps B2B pipeline, bookings, and recognised sales distinct", () => {
    render(<B2bOperations snapshot={{
      openPipelineUsd: "$95,000.00",
      pipelineByStage: [{ stage: "proposal", dealCount: 1, amountUsd: "$95,000.00" }],
      winRate: { percentage: "66.7%", wonCount: 2, lostCount: 1 },
      bookingsThisQuarterUsd: "$20,000.00",
      recognisedSalesThisMonthUsd: null,
      period: { month: "2026-08", monthLabel: "August 2026", quarterLabel: "Q3 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31", quarterStart: "2026-07-01", quarterEnd: "2026-09-30" },
      deals: [
        { id: "11111111-1111-4111-8111-111111111111", bookingId: null, name: "Annual programme", owner: "Layla", stage: "proposal", amountUsd: "95000", originalAmount: "95000", originalCurrency: "USD", exchangeRateToUsd: "1", closeDate: null, renewalDate: null, bookingStatus: "Not booked", recognisedStatus: "Partial", recognisedTotalUsd: "$12,000", issue: "Possible duplicate" },
        { id: "22222222-2222-4222-8222-222222222222", bookingId: "33333333-3333-4333-8333-333333333333", name: "Signed programme", owner: "Tom", stage: "closed_won", amountUsd: "20000", originalAmount: "20000", originalCurrency: "USD", exchangeRateToUsd: "1", closeDate: "2026-08-01", renewalDate: null, bookingStatus: "Booked", recognisedStatus: "Not recognised", recognisedTotalUsd: null, issue: null },
      ],
    }} />);
    expect(screen.getByText("Current eligible open deals")).toBeInTheDocument();
    expect(screen.getByText("Closed-won bookings only")).toBeInTheDocument();
    expect(screen.getByText("Manual Finance entry required; separate from bookings")).toBeInTheDocument();
    expect(screen.getByText("Bookings · Q3 2026")).toBeInTheDocument();
    expect(screen.getByText("Recognised sales · August 2026")).toBeInTheDocument();
    expect(screen.getByText("Open pipeline by stage")).toBeInTheDocument();
    expect(screen.getByText("1 eligible deal")).toBeInTheDocument();
    expect(screen.getByText("Win rate · August 2026")).toBeInTheDocument();
    expect(screen.getByText("2 won · 1 lost, by close date")).toBeInTheDocument();
    expect(screen.getByText("Not yet recorded")).toBeInTheDocument();
    expect(screen.getByText("Total: $12,000")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "B2B financial reporting month" })).toHaveValue("2026-08");
    expect(screen.getByRole("combobox", { name: "Filter B2B deals by stage" })).toHaveValue("all");
    expect(screen.getByText("Annual programme")).toBeInTheDocument();
    expect(screen.getByText("Signed programme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record recognised sale" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record recognised sale" }));
    expect(screen.getByRole("dialog", { name: "Record B2B recognised sale" })).toBeInTheDocument();
    expect(screen.getByLabelText("Reporting month")).toHaveValue("2026-08");
    expect(screen.getByText(/linked to its booking/)).toBeInTheDocument();
    expect(screen.queryByText(/This is a separate, local Finance entry/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close recognised-sales entry" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter B2B deals by stage" }), { target: { value: "all" } });
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter B2B deals by stage" }), { target: { value: "closed_won" } });
    const b2bDealsTable = screen.getByRole("table", { name: "HubSpot B2B deals" });
    expect(within(b2bDealsTable).queryByText("Annual programme")).not.toBeInTheDocument();
    expect(within(b2bDealsTable).getByText("Signed programme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add manual B2B deal" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add manual B2B deal" }));
    expect(screen.getByRole("dialog", { name: "Manual B2B deal entry" })).toBeInTheDocument();
    expect(screen.getByText(/Cash received requires an invoice and receipt/)).toBeInTheDocument();
    expect(screen.getByText(/server-validated, duplicate-checked, and audited/)).toBeInTheDocument();
    expect(screen.queryByText("Payment received status")).not.toBeInTheDocument();
    expect(screen.queryByText("Recognised sales status")).not.toBeInTheDocument();
  });

  it("renders separate report archive output actions", () => {
    render(<ReportsPage />);
    expect(screen.getAllByText("PDF").length).toBeGreaterThan(0);
    expect(screen.getAllByText("CSV").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Search report archive" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Report type" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate report" })).toBeInTheDocument();
  });

  it("discloses when an archived report has no financial data loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reports: [{
          id: "11111111-1111-4111-8111-111111111111",
          reportType: "monthly",
          periodStart: "2026-08-01",
          periodEnd: "2026-08-31",
          status: "completed",
          requestedAt: "2026-08-31T09:00:00.000Z",
          safeErrorSummary: null,
          hasPdf: true,
          hasCsv: true,
          readinessStatus: "draft_fixture_only",
          snapshotVersion: "1",
          coverageSummary: "B2C, B2B, targets, and pipeline are not loaded.",
        }],
      }),
    }));

    try {
      render(<ReportsPage />);

      expect(await screen.findByText("Draft — financial data not loaded")).toBeInTheDocument();
      expect(screen.getByText("B2C, B2B, targets, and pipeline are not loaded.")).toBeInTheDocument();
      expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
