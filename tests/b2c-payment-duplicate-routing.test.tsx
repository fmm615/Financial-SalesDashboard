import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cPaymentReviewDrawer, type B2cPaymentReviewDrawerTarget } from "@/features/b2c/b2c-payment-review-drawer";
import { RoleProvider } from "@/lib/auth/role-context";
import type { B2cReviewRow } from "@/features/b2c/b2c-payment-review-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

const paymentId = "payment-dup-1";

function duplicatePayment(): B2cReviewRow {
  return {
    id: paymentId, recordType: "Payment", customerName: "Reham Al Garash", customerEmail: "rgarash@example.com", customerPhone: null,
    customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
    date: "Oct 5, 2025", dateValue: "2025-10-05", amountUsd: "$475.00", amountValueUsd: "475", sourceAmountUsd: "$475.00", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2025-10-05",
    category: "membership", membershipTier: "Annual", billingInterval: "Annual", source: "Manual bank transfer", paymentStatus: "Completed",
    providerReference: "bank-ref-1", sourceSystem: "manual_bank_transfer", productReference: null, hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
    hasOpenPaymentDuplicate: true, hasDuplicateExclusion: false,
    openReviewFlags: [{ id: "flag-dup-1", type: "Possible duplicate", reason: "A verified local correction matches another completed B2C payment by customer, amount, category, and date within 48 hours." }],
    issue: "Possible duplicate",
    decision: {
      sourceStatus: "succeeded", reconciliationStatus: "duplicate_pending", reportingDecision: "blocked", postingStatus: "not_applicable",
      blockingReasons: ["possible_duplicate"], explanation: "Blocked by an unresolved possible duplicate.",
    },
  } as B2cReviewRow;
}

const financeGroup: Extract<B2cPaymentReviewDrawerTarget, { kind: "financeDuplicate" }>["group"] = {
  groupId: "22222222-2222-4222-8222-222222222222", state: "exact_duplicate_candidate", rows: [
    { financeRowId: "33333333-3333-4333-8333-333333333333", sourceTab: "B2C", sourceRowNumber: 12, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "membership", paymentMethod: "Bank transfer" },
    { financeRowId: "44444444-4444-4444-8444-444444444444", sourceTab: "B2C Cons", sourceRowNumber: 33, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "membership", paymentMethod: "Bank transfer" },
  ],
};

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes("/duplicate-group")) {
      return Promise.resolve({ ok: true, json: async () => ({
        kind: "group",
        group: {
          groupId: "11111111-1111-4111-8111-111111111111",
          detectionReason: "Matching email, USD amount, category, and business date within 48 hours.",
          members: [{
            paymentId, sourceSystem: "manual_bank_transfer", providerReference: "bank-ref-1", customerName: "Reham Al Garash",
            sourceCustomerEmail: "rgarash@example.com", effectiveCustomerEmail: "rgarash@example.com", sourceAmount: "475", sourceCurrency: "USD", effectiveAmountUsd: "475",
            sourceCategoryCode: "membership", effectiveCategoryCode: "membership", sourceOccurredOn: "2025-10-05", effectiveOccurredOn: "2025-10-05",
          }],
        },
      }) });
    }
    if (url.includes("/audit-history")) return Promise.resolve({ ok: true, json: async () => ({ entries: [] }) });
    return Promise.resolve({ ok: false, json: async () => ({ error: "Unexpected request" }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDrawer(target: B2cPaymentReviewDrawerTarget, role: "admin" | "viewer" = "admin") {
  render(<RoleProvider role={role}><B2cPaymentReviewDrawer target={target} onClose={vi.fn()} /></RoleProvider>);
}

describe("B2C payment duplicate routing", () => {
  it("routes a payment duplicate to the payment duplicate review and never the Finance workflow", async () => {
    const fetchMock = stubFetch();
    renderDrawer({ kind: "row", row: duplicatePayment() });

    expect(await screen.findByText("Payment duplicate review")).toBeInTheDocument();
    expect(screen.queryByText("Exact Finance duplicate review")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/b2c/payments/payment-dup-1/duplicate-group",
      { cache: "no-store" },
    );
  });

  it("routes an explicit Finance group to its exact Finance workflow without loading a payment group", () => {
    const fetchMock = stubFetch();
    renderDrawer({ kind: "financeDuplicate", group: financeGroup });

    expect(screen.getByText("Exact Finance duplicate review")).toBeInTheDocument();
    expect(screen.queryByText("Payment duplicate review")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/duplicate-group"), expect.anything());
  });

  it("shows a safe load error when a protected group response has malformed member data", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/duplicate-group")) {
        return Promise.resolve({ ok: true, json: async () => ({
          kind: "group",
          group: { groupId: "11111111-1111-4111-8111-111111111111", detectionReason: "Candidate detected.", members: [{ paymentId } ] },
        }) });
      }
      if (url.includes("/audit-history")) return Promise.resolve({ ok: true, json: async () => ({ entries: [] }) });
      return Promise.resolve({ ok: false, json: async () => ({ error: "Unexpected request" }) });
    }));
    renderDrawer({ kind: "row", row: duplicatePayment() });

    expect(await screen.findByRole("alert")).toHaveTextContent("This payment duplicate review could not be loaded.");
    expect(screen.queryByText("Payment duplicate review")).not.toBeInTheDocument();
  });

  it("keeps both duplicate decision workflows unavailable to a Viewer", async () => {
    const fetchMock = stubFetch();
    renderDrawer({ kind: "row", row: duplicatePayment() }, "viewer");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Viewer access is read-only. Only an Admin can take this action.").length).toBeGreaterThan(0);
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/duplicate-group"), expect.anything()));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/payment-duplicate-groups/"), expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/reconciliation/"), expect.anything());
  });
});
