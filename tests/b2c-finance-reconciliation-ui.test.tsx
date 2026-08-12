import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleProvider } from "@/lib/auth/role-context";
import { B2cReconciliationPage } from "@/features/b2c/b2c-reconciliation-page";

vi.mock("next/navigation", () => ({ usePathname: () => "/operations/b2c/reconciliation" }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

afterEach(() => vi.unstubAllGlobals());

describe("B2C reconciliation review UI", () => {
  it("shows a safe coverage gate without claiming a B2C revenue total to a Viewer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: {
        publicationState: "not_fully_loaded",
        publicationMessage: "Finance revenue is withheld until all sources and Finance approval are complete.",
        sources: [
          { key: "payment_tracker", label: "Payment Tracker", status: "completed" },
          { key: "tap_statement", label: "Tap statement", status: "completed" },
          { key: "stripe_charges", label: "Stripe Charges", status: "not_loaded" },
        ],
        counts: { stagedRows: 1268, validRows: 950, needsReviewRows: 298, zeroValueRows: 5, invalidRows: 15, unresolvedGroups: 0 },
      } }),
    }));

    render(<RoleProvider role="viewer"><B2cReconciliationPage /></RoleProvider>);

    expect(await screen.findByText("Not fully loaded")).toBeInTheDocument();
    expect(screen.getByText("1,268")).toBeInTheDocument();
    expect(screen.getByText("Stripe Charges")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve canonical sale" })).not.toBeInTheDocument();
  });
});
