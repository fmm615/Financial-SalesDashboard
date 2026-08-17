import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cFinanceActionModule } from "@/features/b2c/b2c-finance-action-module";
import { B2cFinanceDuplicateActions } from "@/features/b2c/b2c-finance-duplicate-actions";
import { B2cFinanceDataQualityActions } from "@/features/b2c/b2c-finance-data-quality-actions";
import { B2cFinancePaymentEvidence } from "@/features/b2c/b2c-finance-payment-evidence";
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

const duplicateGroups: B2cFinanceActionOverview["duplicateGroups"] = [{
  groupId: "11111111-1111-4111-8111-111111111111",
  state: "exact_duplicate_candidate",
  recommendation: {
    groupId: "11111111-1111-4111-8111-111111111111",
    sourceTab: "B2C Cons",
    canonicalFinanceRowId: "33333333-3333-4333-8333-333333333333",
    eligibleForBulk: true,
    winningCompleteness: 7,
    otherCompleteness: 2,
  },
  rows: [
    { financeRowId: "22222222-2222-4222-8222-222222222222", sourceTab: "B2C", sourceRowNumber: 12, reportedDateRaw: "05/10/2025", declaredMonth: "October", declaredYear: "2025", occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham Garash", customerEmail: null, customerPhone: null, category: "Membership", membershipType: null, paymentMethod: "Stripe", paymentStatus: null, note: null, qualityIssues: [] },
    { financeRowId: "33333333-3333-4333-8333-333333333333", sourceTab: "B2C Cons", sourceRowNumber: 33, reportedDateRaw: "05/10/2025", declaredMonth: "October", declaredYear: "2025", occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham Garash", customerEmail: "rgarash@example.com", customerPhone: "+973 3000 0000", category: "Membership", membershipType: "Female Founder Club", paymentMethod: "Stripe", paymentStatus: "Received", note: "Full payment", qualityIssues: [] },
  ],
}];

const overview: B2cFinanceActionOverview = {
  counts: {
    duplicateDecisions: 43,
    duplicateSourceRows: 86,
    bulkEligibleDuplicateDecisions: 43,
    dateAuthorityActions: 10,
    correctionActions: 5,
    postedFinancePayments: 161,
  },
  duplicateGroups,
  items: [
    ...duplicateItems,
    { id: "date-authority:22222222-2222-4222-8222-222222222222", actionType: "date_authority", actionLabel: "Use the verified Date", explanation: "The Date is valid, but the Month label conflicts with it.", sourceTab: "B2C", sourceRowNumber: 12, evidence: duplicateGroups[0].rows[0] },
    { id: "correction:33333333-3333-4333-8333-333333333333", actionType: "correction", actionLabel: "Correct verified information", explanation: "The workbook row has no customer name.", sourceTab: "B2C Cons", sourceRowNumber: 31, evidence: duplicateGroups[0].rows[1] },
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

  it("shows both payments and requires a reason and confirmation before recording the selected pair", () => {
    render(<B2cFinanceDuplicateActions overview={overview} onChanged={vi.fn()} />);

    expect(screen.getByText("B2C row 12")).toBeInTheDocument();
    expect(screen.getByText("B2C Cons row 33")).toBeInTheDocument();
    expect(screen.getByText("rgarash@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep B2C" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep B2C Cons" })).toBeInTheDocument();
    expect(screen.getByText("1 selected payment pair")).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Record selected duplicate decisions" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for recording these duplicate decisions"), { target: { value: "B2C Cons contains the fuller verified Finance record." } });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I understand that one audited decision will be recorded for each selected pair."));
    expect(confirm).toBeEnabled();
  });

  it("shows the source payment details before a Date or correction decision", () => {
    render(<B2cFinanceDataQualityActions overview={overview} onChanged={vi.fn()} />);

    expect(screen.getAllByText("Source workbook details")).toHaveLength(2);
    expect(screen.getAllByText("Female Founder Club")).toHaveLength(1);
    expect(screen.getAllByText("05/10/2025")).toHaveLength(2);
  });

  it("renders a numeric provider amount without crashing", () => {
    render(<B2cFinancePaymentEvidence heading="Source workbook details" evidence={{ ...duplicateGroups[0].rows[0], amountUsd: 475 as unknown as string }} />);

    expect(screen.getByText("475")).toBeInTheDocument();
  });
});
