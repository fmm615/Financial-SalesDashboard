import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cExactDuplicateReview } from "@/features/b2c/b2c-exact-duplicate-review";

afterEach(() => vi.unstubAllGlobals());

const group = { groupId: "22222222-2222-4222-8222-222222222222", state: "exact_duplicate_candidate", rows: [
  { financeRowId: "33333333-3333-4333-8333-333333333333", sourceTab: "B2C", sourceRowNumber: 12, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
  { financeRowId: "44444444-4444-4444-8444-444444444444", sourceTab: "B2C Cons", sourceRowNumber: 33, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
] };

describe("B2C exact duplicate review", () => {
  it("requires a selected canonical Finance row and a reason before it records a decision", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ groups: [group] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ decisionId: "decision-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn().mockResolvedValue(undefined);

    render(<B2cExactDuplicateReview onGroupsChanged={changed} />);

    expect(await screen.findByText("B2C row 12")).toBeInTheDocument();
    expect(screen.getByText("B2C Cons row 33")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm canonical Finance row" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Use B2C row 12 as canonical"));
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Finance verified the two workbook rows are the same sale." } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/b2c/reconciliation/22222222-2222-4222-8222-222222222222/decision",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("33333333-3333-4333-8333-333333333333") }),
    ));
    expect(screen.queryByText("$475")).not.toBeInTheDocument();
  });
});
