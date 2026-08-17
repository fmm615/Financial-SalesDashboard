import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cFinanceActionModule } from "@/features/b2c/b2c-finance-action-module";
import { B2cFinanceDuplicateActions } from "@/features/b2c/b2c-finance-duplicate-actions";
import type { B2cFinanceActionOverview } from "@/server/services/b2c-finance-action-center";

afterEach(() => vi.unstubAllGlobals());

const duplicateItems = Array.from({ length: 43 }, (_, index) => ({
  id: `duplicate:11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
  actionType: "duplicate" as const,
  actionLabel: "Keep the fuller B2C Cons record",
  explanation: "The two workbook rows are an exact duplicate.",
  sourceTab: "B2C Cons" as const,
  sourceRowNumber: null,
}));

const overview: B2cFinanceActionOverview = {
  counts: {
    duplicateDecisions: 43,
    duplicateSourceRows: 86,
    bulkEligibleDuplicateDecisions: 43,
    dateAuthorityActions: 10,
    correctionActions: 5,
    postedFinancePayments: 161,
  },
  items: [
    ...duplicateItems,
    { id: "date-authority:22222222-2222-4222-8222-222222222222", actionType: "date_authority", actionLabel: "Use the verified Date", explanation: "The Date is valid, but the Month label conflicts with it.", sourceTab: "B2C", sourceRowNumber: 12 },
    { id: "correction:33333333-3333-4333-8333-333333333333", actionType: "correction", actionLabel: "Correct verified information", explanation: "The workbook row has no customer name.", sourceTab: "B2C Cons", sourceRowNumber: 31 },
  ],
};

describe("B2C Finance action module", () => {
  it("shows decisions rather than duplicate source-row copies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overview }) }));

    render(<B2cFinanceActionModule />);

    expect(await screen.findByText("43 duplicate decisions")).toBeInTheDocument();
    expect(screen.getByText("86 retained workbook rows are represented by these decisions.")).toBeInTheDocument();
    expect(screen.getByText("10 Date checks")).toBeInTheDocument();
    expect(screen.getByText("5 corrections needed")).toBeInTheDocument();
    expect(screen.getByText("161 already in B2C ledger")).toBeInTheDocument();
  });

  it("requires a reason and confirmation before applying a recommended duplicate decision", () => {
    render(<B2cFinanceDuplicateActions overview={overview} onChanged={vi.fn()} />);

    const confirm = screen.getByRole("button", { name: "Use B2C Cons for 43 payments" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for keeping B2C Cons"), { target: { value: "B2C Cons contains the fuller verified Finance record." } });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I understand that one decision will be recorded for each proven duplicate pair."));
    expect(confirm).toBeEnabled();
  });
});
