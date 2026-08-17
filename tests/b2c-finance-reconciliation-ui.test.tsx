import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.queryByRole("button", { name: "Post approved Finance payments" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Payment Tracker workbook")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tap statement CSV")).not.toBeInTheDocument();
  });

  it("allows an Admin to preview then explicitly stage one workbook without showing a Finance total", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ summary: { publicationState: "not_fully_loaded", publicationMessage: "Finance revenue is withheld.", sources: [], counts: { stagedRows: 0, validRows: 0, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0, unresolvedGroups: 0 } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ preview: { sourceFileSha256: "a".repeat(64), acceptedTabs: ["B2C", "B2C Cons"], summary: { totalRows: 2, validRows: 2, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0 }, issueCounts: {}, duplicateCandidates: { exact: 1, possible: 0, conflicts: 0 } } }) }));
    render(<RoleProvider role="admin"><B2cReconciliationPage /></RoleProvider>);
    const input = await screen.findByLabelText("Payment Tracker workbook");
    fireEvent.change(input, { target: { files: [new File(["bytes"], "Payment Tracker.xlsx")] } });
    expect(screen.getByRole("button", { name: "Confirm staged import" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview workbook" }));
    await waitFor(() => expect(screen.getByText("2 extracted rows")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Confirm staged import" })).toBeEnabled();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("allows an Admin to preview a Tap CSV using safe evidence counts only", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ summary: { publicationState: "not_fully_loaded", publicationMessage: "Finance revenue is withheld.", sources: [], counts: { stagedRows: 0, validRows: 0, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0, unresolvedGroups: 0 } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ preview: { sourceFileSha256: "c".repeat(64), totalRows: 836, kindCounts: { sale: 200, processing_fee: 200, fee_vat: 200, refund: 0, transfer: 100, opening_balance: 1, needs_review: 135 }, missingPaymentIdSales: 0, unparsedDates: 836 } }) }));
    render(<RoleProvider role="admin"><B2cReconciliationPage /></RoleProvider>);
    const input = await screen.findByLabelText("Tap statement CSV");
    fireEvent.change(input, { target: { files: [new File(["bytes"], "Tap Statement.csv")] } });
    expect(screen.getByRole("button", { name: "Confirm Tap staged import" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Tap statement" }));
    await waitFor(() => expect(screen.getByText("836 evidence rows")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Confirm Tap staged import" })).toBeEnabled();
    expect(screen.getByText(/200 sales/)).toBeInTheDocument();
    expect(screen.queryByText("BHD 74.570")).not.toBeInTheDocument();
  });

  it("shows the approved Finance posting action only after the Payment Tracker is staged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ summary: {
      publicationState: "not_fully_loaded", publicationMessage: "Finance revenue is withheld.",
      sources: [{ key: "payment_tracker", label: "Payment Tracker", status: "completed" }],
      counts: { stagedRows: 2, validRows: 2, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0, unresolvedGroups: 0 },
    } }) }));

    render(<RoleProvider role="admin"><B2cReconciliationPage /></RoleProvider>);

    expect(await screen.findByRole("button", { name: "Post approved Finance payments" })).toBeInTheDocument();
    expect(screen.getByText(/does not alter the workbook/i)).toBeInTheDocument();
  });
});
