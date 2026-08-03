import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { ExecutiveDashboard } from "@/features/executive/executive-dashboard";
import { B2bOperations } from "@/features/b2b/b2b-operations";
import { ReportsPage } from "@/features/reports/reports-page";
import { ReviewQueuePage } from "@/features/review-queue/review-queue-page";
import { EmptyState, LoadingSkeleton, NotBackfilledState } from "@/components/ui";

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
      bookingsThisQuarterUsd: "$20,000.00",
      recognisedSalesThisMonthUsd: "$2,000.00",
      period: { month: "2026-08", monthLabel: "August 2026", quarterLabel: "Q3 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31", quarterStart: "2026-07-01", quarterEnd: "2026-09-30" },
      deals: [{ id: "deal-1", name: "Annual programme", owner: "Layla", stage: "proposal", amountUsd: "95000", originalAmount: "95000", originalCurrency: "USD", exchangeRateToUsd: "1", closeDate: null, renewalDate: null, bookingStatus: "Not booked", recognisedStatus: "Partial", issue: "Possible duplicate" }],
    }} />);
    expect(screen.getByText("Current eligible open deals")).toBeInTheDocument();
    expect(screen.getByText("Closed-won bookings only")).toBeInTheDocument();
    expect(screen.getByText("Separate from bookings")).toBeInTheDocument();
    expect(screen.getByText("Bookings · Q3 2026")).toBeInTheDocument();
    expect(screen.getByText("Recognised sales · August 2026")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "B2B financial reporting month" })).toHaveValue("2026-08");
    expect(screen.getByText("Annual programme")).toBeInTheDocument();
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
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
});
