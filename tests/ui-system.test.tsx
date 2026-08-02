import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { ExecutiveDashboard } from "@/features/executive/executive-dashboard";
import { B2bOperations } from "@/features/b2b/b2b-operations";
import { ReportsPage } from "@/features/reports/reports-page";
import { ReviewQueuePage } from "@/features/review-queue/review-queue-page";
import { EmptyState, LoadingSkeleton, NotBackfilledState } from "@/components/ui";

vi.mock("next/navigation", () => ({ usePathname: () => "/executive" }));
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
    render(<B2bOperations />);
    expect(screen.getByText("Upcoming renewals")).toBeInTheDocument();
    expect(screen.getByText("Top open deals")).toBeInTheDocument();
    expect(screen.getAllByText("Recognised sales").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Add manual B2B deal" })).toBeInTheDocument();
  });

  it("renders separate report archive output actions", () => {
    render(<ReportsPage />);
    expect(screen.getAllByText("PDF").length).toBeGreaterThan(0);
    expect(screen.getAllByText("CSV").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Search records" })).toBeInTheDocument();
  });
});
