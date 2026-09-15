import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cPaymentReviewDrawer, type B2cPaymentReviewDrawerTarget } from "@/features/b2c/b2c-payment-review-drawer";
import { RoleProvider } from "@/lib/auth/role-context";
import type { B2cReviewRow } from "@/features/b2c/b2c-payment-review-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

function duplicateFlaggedRow(): B2cReviewRow {
  return {
    id: "payment-dup-1", recordType: "Payment", customerName: "Reham Al Garash", customerEmail: "rgarash@example.com", customerPhone: null,
    customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
    date: "Oct 5, 2025", dateValue: "2025-10-05", amountUsd: "$475.00", amountValueUsd: "475", sourceAmountUsd: "$475.00", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2025-10-05",
    membershipTier: "Annual", billingInterval: "Annual", source: "Stripe", paymentStatus: "Completed",
    providerReference: "ch_dup_1", sourceSystem: "stripe", productReference: "price_annual", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
    hasOpenPaymentDuplicate: true, hasDuplicateExclusion: false,
    openReviewFlags: [{ id: "flag-dup-1", type: "Possible duplicate", reason: "A verified local correction matches another completed B2C payment by customer, amount, and date within 48 hours." }],
    issue: "Possible duplicate",
    decision: {
      sourceStatus: "succeeded", reconciliationStatus: "duplicate_pending", reportingDecision: "blocked", postingStatus: "not_applicable",
      blockingReasons: ["possible_duplicate"], explanation: "Blocked by an unresolved possible duplicate.",
    },
  } as B2cReviewRow;
}

function stubFetch(handlers: Array<[string, () => { ok: boolean; json: () => Promise<unknown> }]>) {
  const fetchMock = vi.fn((url: string) => {
    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) return Promise.resolve(handler());
    }
    if (url.includes("/audit-history")) return Promise.resolve({ ok: true, json: async () => ({ entries: [] }) });
    return Promise.resolve({ ok: false, json: async () => ({ error: "not mocked in this test" }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDrawer(target: B2cPaymentReviewDrawerTarget, role: "admin" | "viewer" = "admin") {
  const onClose = vi.fn();
  render(<RoleProvider role={role}><B2cPaymentReviewDrawer target={target} onClose={onClose} /></RoleProvider>);
  return onClose;
}

describe("B2C payment duplicate drawer actions", () => {
  it("opens the payment duplicate review for a record with an open possible duplicate", async () => {
    const fetchMock = stubFetch([
      ["/duplicate-group", () => ({ ok: true, json: async () => ({ kind: "group", group: {
        groupId: "11111111-1111-4111-8111-111111111111", detectionReason: "Matching payment facts within the approved window.", members: [
          { paymentId: "payment-dup-1", sourceSystem: "stripe", providerReference: "ch_dup_1", customerName: "Reham Al Garash", sourceCustomerEmail: "rgarash@example.com", effectiveCustomerEmail: "rgarash@example.com", sourceAmount: "475", sourceCurrency: "USD", effectiveAmountUsd: "475", sourceOccurredOn: "2025-10-05", effectiveOccurredOn: "2025-10-05" },
          { paymentId: "payment-dup-2", sourceSystem: "manual_bank_transfer", providerReference: "bank-ref-2", customerName: "Reham Al Garash", sourceCustomerEmail: "rgarash@example.com", effectiveCustomerEmail: "reham@example.com", sourceAmount: "475", sourceCurrency: "USD", effectiveAmountUsd: "475", sourceOccurredOn: "2025-10-05", effectiveOccurredOn: "2025-10-05" },
        ],
      } }) })],
    ]);
    renderDrawer({ kind: "row", row: duplicateFlaggedRow() });
    const dialog = screen.getByRole("dialog");

    expect(await within(dialog).findByText("Payment duplicate review")).toBeInTheDocument();
    expect(within(dialog).getByText("bank-ref-2")).toBeInTheDocument();
    expect(within(dialog).getByText("Effective comparison value:")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/reconciliation/exact-duplicates"), expect.anything());
  });

  it("requires a meaningful reason before resolving every payment in an explicit keep-all decision", async () => {
    const fetchMock = stubFetch([
      ["/duplicate-group", () => ({ ok: true, json: async () => ({ kind: "group", group: {
        groupId: "11111111-1111-4111-8111-111111111111", detectionReason: "Matching payment facts within the approved window.", members: [
          { paymentId: "payment-dup-1", sourceSystem: "stripe", providerReference: "ch_dup_1", customerName: "Reham Al Garash", sourceCustomerEmail: "rgarash@example.com", effectiveCustomerEmail: "rgarash@example.com", sourceAmount: "475", sourceCurrency: "USD", effectiveAmountUsd: "475", sourceOccurredOn: "2025-10-05", effectiveOccurredOn: "2025-10-05" },
          { paymentId: "payment-dup-2", sourceSystem: "manual_bank_transfer", providerReference: "bank-ref-2", customerName: "Reham Al Garash", sourceCustomerEmail: "rgarash@example.com", effectiveCustomerEmail: "rgarash@example.com", sourceAmount: "475", sourceCurrency: "USD", effectiveAmountUsd: "475", sourceOccurredOn: "2025-10-05", effectiveOccurredOn: "2025-10-05" },
        ],
      } }) })],
      ["/payment-duplicate-groups/", () => ({ ok: true, json: async () => ({ groupId: "11111111-1111-4111-8111-111111111111", resolvedPaymentIds: ["payment-dup-1", "payment-dup-2"] }) })],
    ]);
    const onClose = renderDrawer({ kind: "row", row: duplicateFlaggedRow() });

    const reason = await screen.findByLabelText("Payment duplicate decision reason");
    const keepAll = screen.getByRole("button", { name: "Keep all payments" });
    expect(keepAll).toBeDisabled();
    fireEvent.change(reason, { target: { value: "Finance verified both provider records are separate payments." } });
    expect(keepAll).toBeEnabled();
    fireEvent.click(keepAll);

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/b2c/payment-duplicate-groups/11111111-1111-4111-8111-111111111111/decision",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "keep_all", canonicalPaymentId: null, reason: "Finance verified both provider records are separate payments." }) }),
    ));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("never shows a manual Find-exact-duplicates trigger -- groups are created automatically from a payment write", async () => {
    stubFetch([]);
    renderDrawer({ kind: "row", row: duplicateFlaggedRow() });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).queryByRole("button", { name: "Find exact duplicates" })).not.toBeInTheDocument();
  });
});
