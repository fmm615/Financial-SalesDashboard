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

  it("shows a read-only review drawer for a Viewer", () => {
    render(<RoleProvider role="viewer"><ReviewQueuePage /></RoleProvider>);
    fireEvent.click(screen.getByText("Potential repeated membership payment"));
    expect(screen.getByText(/Only an Admin can resolve this flag/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as reviewed" })).not.toBeInTheDocument();
  });
});
