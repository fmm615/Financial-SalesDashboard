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
    category: "membership", membershipTier: "Annual", billingInterval: "Annual", source: "Stripe", paymentStatus: "Completed",
    providerReference: "ch_dup_1", sourceSystem: "stripe", productReference: "price_annual", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
    hasOpenPaymentDuplicate: true, hasDuplicateExclusion: false,
    openReviewFlags: [{ id: "flag-dup-1", type: "Possible duplicate", reason: "A verified local correction matches another completed B2C payment by customer, amount, category, and date within 48 hours." }],
    issue: "Possible duplicate",
    decision: {
      sourceStatus: "succeeded", reconciliationStatus: "duplicate_pending", reportingDecision: "blocked", postingStatus: "not_applicable",
      blockingReasons: ["possible_duplicate"], explanation: "Blocked by an unresolved possible duplicate.",
    },
  } as B2cReviewRow;
}

const group: Extract<B2cPaymentReviewDrawerTarget, { kind: "financeDuplicate" }>["group"] = {
  groupId: "22222222-2222-4222-8222-222222222222", state: "exact_duplicate_candidate", rows: [
    { financeRowId: "33333333-3333-4333-8333-333333333333", sourceTab: "B2C", sourceRowNumber: 12, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
    { financeRowId: "44444444-4444-4444-8444-444444444444", sourceTab: "B2C Cons", sourceRowNumber: 33, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
  ],
};

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

describe("B2C payment and Finance duplicate drawer actions", () => {
  it("keeps a payment duplicate in its payment-record drawer instead of rendering a Finance exact pair", () => {
    const fetchMock = stubFetch([]);
    renderDrawer({ kind: "row", row: duplicateFlaggedRow() });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText(/This payment has an unresolved duplicate group/)).toBeInTheDocument();
    expect(within(dialog).queryByText("B2C row 12")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/reconciliation/exact-duplicates"), expect.anything());
  });

  it("never shows a manual Find-exact-duplicates trigger -- groups are created automatically during Payment Tracker finalization", async () => {
    stubFetch([]);
    renderDrawer({ kind: "row", row: duplicateFlaggedRow() });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).queryByRole("button", { name: "Find exact duplicates" })).not.toBeInTheDocument();
  });

  it("records a Finance exact-pair decision through the existing per-group reconciliation route with one selection and one reason", async () => {
    const fetchMock = stubFetch([
      ["/decision", () => ({ ok: true, json: async () => ({ decisionId: "decision-1" }) })],
    ]);
    const onClose = renderDrawer({ kind: "financeDuplicate", group });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("B2C row 12")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Confirm canonical Finance row" });
    expect(confirm).toBeDisabled();

    fireEvent.click(within(dialog).getByLabelText("Use B2C row 12 as canonical"));
    fireEvent.change(within(dialog).getByLabelText("Decision reason"), { target: { value: "Finance verified the two workbook rows are the same sale." } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/b2c/reconciliation/22222222-2222-4222-8222-222222222222/decision",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("33333333-3333-4333-8333-333333333333") }),
    ));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("replaces the retained Finance pair when a direct Finance deep link changes groups", () => {
    const nextGroup = {
      ...group,
      groupId: "55555555-5555-4555-8555-555555555555",
      rows: group.rows.map((row, index) => ({ ...row, sourceRowNumber: index === 0 ? 88 : 99 })),
    };
    const onClose = vi.fn();
    const rendered = render(<RoleProvider role="admin"><B2cPaymentReviewDrawer target={{ kind: "financeDuplicate", group }} onClose={onClose} /></RoleProvider>);
    expect(screen.getByText("B2C row 12")).toBeInTheDocument();

    rendered.rerender(<RoleProvider role="admin"><B2cPaymentReviewDrawer target={{ kind: "financeDuplicate", group: nextGroup }} onClose={onClose} /></RoleProvider>);

    expect(screen.getByText("B2C row 88")).toBeInTheDocument();
    expect(screen.queryByText("B2C row 12")).not.toBeInTheDocument();
  });

  it("never lets a Viewer see or trigger a Finance duplicate decision", () => {
    const fetchMock = stubFetch([]);
    renderDrawer({ kind: "financeDuplicate", group }, "viewer");
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getAllByText("Viewer access is read-only. Only an Admin can take this action.").length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).queryByText("B2C row 12")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
