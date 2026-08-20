import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";
import { AdminPage } from "@/features/admin/admin-page";
import { RoleProvider } from "@/lib/auth/role-context";
import B2cReconciliationRoute from "@/app/operations/b2c/reconciliation/page";
import B2cFinanceAdministrationPage from "@/app/admin/b2c-finance/page";

/**
 * Ownership acceptance tests for Task 4: a live B2C action renders in exactly
 * one place, the two retired front doors redirect rather than duplicate a
 * live surface, and Administration keeps no B2C-specific control. See
 * "One Owner Per Workflow" and "Final Admin Experience" in
 * docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md.
 */
describe("B2C UI ownership", () => {
  it("keeps exactly one B2C navigation entry for Admin and Viewer", () => {
    const { rerender } = render(<RoleProvider role="admin"><AppShell title="Test" description="Test"><p>Body</p></AppShell></RoleProvider>);
    expect(screen.getByRole("link", { name: "B2C" })).toHaveAttribute("href", "/operations/b2c");
    expect(screen.queryByRole("link", { name: "B2C reconciliation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "B2C Finance" })).not.toBeInTheDocument();

    rerender(<RoleProvider role="viewer"><AppShell title="Test" description="Test"><p>Body</p></AppShell></RoleProvider>);
    expect(screen.getByRole("link", { name: "B2C" })).toHaveAttribute("href", "/operations/b2c");
    expect(screen.queryByRole("link", { name: "B2C reconciliation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "B2C Finance" })).not.toBeInTheDocument();
  });

  it("redirects the retired B2C reconciliation URL into Sources instead of serving a second live page", () => {
    let caught: unknown;
    try {
      B2cReconciliationRoute();
    } catch (error) {
      caught = error;
    }
    expect((caught as { digest?: string } | undefined)?.digest).toBe("NEXT_REDIRECT;replace;/operations/b2c?tab=sources;307;");
  });

  it("redirects the retired B2C Finance URL into the Work queue's ready-to-post filter instead of serving a second live page", () => {
    let caught: unknown;
    try {
      B2cFinanceAdministrationPage();
    } catch (error) {
      caught = error;
    }
    expect((caught as { digest?: string } | undefined)?.digest).toBe("NEXT_REDIRECT;replace;/operations/b2c?tab=work&queue=ready_to_post;307;");
  });

  it("keeps Administration free of B2C correction, mapping, manual-payment, Stripe, and Tap controls", () => {
    render(<RoleProvider role="admin"><AdminPage /></RoleProvider>);

    expect(screen.queryByRole("button", { name: "Bank transfer entry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Correct a record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Product mapping" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Stripe now")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Tap now")).not.toBeInTheDocument();
    expect(screen.queryByText(/historical Stripe import/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/historical Tap import/i)).not.toBeInTheDocument();

    // Administration keeps only HubSpot and genuinely cross-product sections.
    expect(screen.getByRole("button", { name: "Targets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summit tracker" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /User access/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integration status" })).toBeInTheDocument();
  });
});
