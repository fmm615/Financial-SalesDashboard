import { createElement, type ComponentType, type ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cPaymentReviewDrawer } from "@/features/b2c/b2c-payment-review-drawer";
import type { B2cReviewRow } from "@/features/b2c/b2c-payment-review-actions";
import { RoleProvider } from "@/lib/auth/role-context";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

function unmappedProviderRow(): B2cReviewRow {
  return {
    id: "payment-unmapped", recordType: "Payment", customerName: "Maya Al Khalifa", customerEmail: "maya@example.com", customerPhone: null,
    customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
    date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$100.00", amountValueUsd: "100", sourceAmountUsd: "$100.00", sourceOriginalCurrency: "USD", sourceDescription: "Provider Annual Plan", sourceDateValue: "2026-08-09",
    category: "Unmapped", membershipTier: null, billingInterval: null, source: "Stripe", paymentStatus: "Completed",
    providerReference: "ch_unmapped", sourceSystem: "stripe", productReference: "price_annual", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
    openReviewFlags: [{ id: "historic-unmapped", type: "Unmapped product" as never, reason: "Retained for audit history." }], issue: null,
    decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "reportable", postingStatus: "not_applicable", blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
  } as unknown as B2cReviewRow;
}

describe("retired provider product mapping UI", () => {
  it("does not render a mapping action or request the mapping API for an unmapped provider record", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/audit-history")) return Promise.resolve({ ok: true, json: async () => ({ entries: [] }) });
      if (url.includes("/evidence")) return Promise.resolve({ ok: true, json: async () => ({
        paymentId: "payment-unmapped", source: "Stripe", sourceSystem: "stripe", providerReference: "ch_unmapped", date: "Aug 9, 2026",
        stripeEvidence: {
          originalCurrency: "USD", originalAmount: "100.00", amountRefunded: "0", description: "Provider Annual Plan", sellerMessage: null, cardholderName: null,
          settlementGrossAmount: null, settlementCurrency: null, settlementExchangeRate: null, settlementFeeAmount: null, settlementFeeTaxAmount: null, settlementNetAmount: null, refunds: [],
        },
      }) });
      return Promise.resolve({ ok: false, json: async () => ({ error: "not mocked" }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const TestRoleProvider = RoleProvider as ComponentType<{ role: "admin"; children?: ReactNode }>;
    render(createElement(TestRoleProvider, { role: "admin" }, createElement(B2cPaymentReviewDrawer, { target: { kind: "row", row: unmappedProviderRow() }, onClose: vi.fn() })));

    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText("Provider Annual Plan")).toBeInTheDocument();
    expect(within(dialog).queryByText("Create reusable product mapping")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Map this")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save local product mapping" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close record drawer" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/b2c/products/map", expect.anything());
  });
});
