import { describe, expect, it } from "vitest";
import {
  createB2cFinanceActionCenter,
  getCanonicalRecommendation,
  summarizeFinancePostingReadiness,
  type B2cFinanceActionCenterRepository,
  type B2cFinanceDuplicateCandidate,
  type FinancePostingReadinessRow,
} from "@/server/services/b2c-finance-action-center";

const completeB2cConsPair: B2cFinanceDuplicateCandidate = {
  groupId: "11111111-1111-4111-8111-111111111111",
  state: "exact_duplicate_candidate",
  rows: [
    {
      financeRowId: "22222222-2222-4222-8222-222222222222",
      sourceTab: "B2C",
      sourceRowNumber: 12,
      reportedDateRaw: "05/10/2025",
      declaredMonth: "October",
      declaredYear: "2025",
      occurredOn: "2025-10-05",
      amountUsd: "475",
      customerName: "Reham Garash",
      customerEmail: null,
      customerPhone: null,
      category: "Membership",
      membershipType: null,
      paymentStatus: null,
      note: null,
      paymentMethod: "Stripe",
      qualityIssues: [],
    },
    {
      financeRowId: "33333333-3333-4333-8333-333333333333",
      sourceTab: "B2C Cons",
      sourceRowNumber: 33,
      reportedDateRaw: "05/10/2025",
      declaredMonth: "October",
      declaredYear: "2025",
      occurredOn: "2025-10-05",
      amountUsd: "475",
      customerName: "Reham Garash",
      customerEmail: "reham@example.com",
      customerPhone: "+973 3000 0000",
      category: "Membership",
      membershipType: "Female Founder Club",
      paymentStatus: "Received",
      note: "Full payment",
      paymentMethod: "Stripe",
      qualityIssues: [],
    },
  ],
};

describe("B2C Finance duplicate recommendations", () => {
  it("recommends B2C Cons only when it has more usable Finance fields", () => {
    expect(getCanonicalRecommendation(completeB2cConsPair)).toMatchObject({
      sourceTab: "B2C Cons",
      canonicalFinanceRowId: "33333333-3333-4333-8333-333333333333",
      eligibleForBulk: true,
    });
  });

  it("keeps an equally complete pair for individual review", () => {
    const equalPair: B2cFinanceDuplicateCandidate = {
      ...completeB2cConsPair,
      rows: completeB2cConsPair.rows.map((row) => ({
        ...row,
        customerEmail: null,
        customerPhone: null,
        membershipType: null,
        paymentStatus: null,
        note: null,
      })),
    };

    expect(getCanonicalRecommendation(equalPair)).toMatchObject({ eligibleForBulk: false });
  });

  it("shows one duplicate decision for two retained rows and labels a verified Date action", async () => {
    const repository: B2cFinanceActionCenterRepository = {
      listPendingExactDuplicateGroups: async () => [completeB2cConsPair],
      listNeedsReviewRows: async () => [{
        financeRowId: "44444444-4444-4444-8444-444444444444",
        sourceTab: "B2C Cons",
        sourceRowNumber: 14,
        reportedDateRaw: "05/10/2025",
        declaredMonth: "September",
        declaredYear: "2025",
        occurredOn: "2025-10-05",
        amountUsd: "275",
        customerName: "Member name",
        customerEmail: null,
        customerPhone: null,
        category: "Membership",
        membershipType: null,
        paymentMethod: "Bank transfer",
        paymentStatus: "Received",
        note: null,
        qualityIssues: ["declared_month_conflicts_with_date"],
      }],
      countPostedFinancePayments: async () => 161,
      getFinancePostingReadinessRows: async () => [
        { rowKind: "lineage", status: "ready", financePaymentMethod: "ios" },
        { rowKind: "lineage", status: "already_posted", financePaymentMethod: "bank_transfer" },
        { rowKind: "pending_candidate", candidateKind: "ambiguous", financeRowCount: 2 },
      ],
    };

    const overview = await createB2cFinanceActionCenter(repository).overview();

    expect(overview.counts).toMatchObject({ duplicateDecisions: 1, duplicateSourceRows: 2, dateAuthorityActions: 1, correctionActions: 0, postedFinancePayments: 161 });
    expect(overview.counts.postingReadiness).toEqual({
      readyLineages: 1, readyIosLineages: 1, readyBankTransferLineages: 0,
      alreadyPostedLineages: 1, blockedRows: 0, ambiguousRows: 2,
    });
    expect(overview.duplicateGroups[0]?.groupId).toBe(completeB2cConsPair.groupId);
    expect(overview.duplicateGroups[0]?.rows[0]).toMatchObject({ sourceTab: "B2C", customerName: "Reham Garash", amountUsd: "475" });
    expect(overview.items).toContainEqual(expect.objectContaining({ actionLabel: "Use the verified Date", sourceRowNumber: 14 }));
    expect(overview.items.find((item) => item.actionType === "date_authority")?.evidence).toMatchObject({
      sourceTab: "B2C Cons", sourceRowNumber: 14, occurredOn: "2025-10-05", qualityIssues: ["declared_month_conflicts_with_date"],
    });
  });
});

describe("summarizeFinancePostingReadiness", () => {
  it("counts a replacement-workbook row as already posted through its lineage", () => {
    expect(summarizeFinancePostingReadiness([
      { rowKind: "lineage", status: "already_posted", financePaymentMethod: "bank_transfer" },
    ])).toEqual({
      readyLineages: 0, readyIosLineages: 0, readyBankTransferLineages: 0,
      alreadyPostedLineages: 1, blockedRows: 0, ambiguousRows: 0,
    });
  });

  it("counts a lineage represented by a manual bank transfer the same as already posted", () => {
    expect(summarizeFinancePostingReadiness([
      { rowKind: "lineage", status: "represented", financePaymentMethod: "bank_transfer" },
    ])).toEqual({
      readyLineages: 0, readyIosLineages: 0, readyBankTransferLineages: 0,
      alreadyPostedLineages: 1, blockedRows: 0, ambiguousRows: 0,
    });
  });

  it("counts ready lineages separately by payment method", () => {
    expect(summarizeFinancePostingReadiness([
      { rowKind: "lineage", status: "ready", financePaymentMethod: "ios" },
      { rowKind: "lineage", status: "ready", financePaymentMethod: "bank_transfer" },
    ])).toEqual({
      readyLineages: 2, readyIosLineages: 1, readyBankTransferLineages: 1,
      alreadyPostedLineages: 0, blockedRows: 0, ambiguousRows: 0,
    });
  });

  it("counts a blocked lineage as a blocked row", () => {
    expect(summarizeFinancePostingReadiness([
      { rowKind: "lineage", status: "blocked", financePaymentMethod: null },
    ])).toEqual({
      readyLineages: 0, readyIosLineages: 0, readyBankTransferLineages: 0,
      alreadyPostedLineages: 0, blockedRows: 1, ambiguousRows: 0,
    });
  });

  it("counts an ambiguous pending candidate's rows as ambiguous, and other pending candidates as blocked", () => {
    expect(summarizeFinancePostingReadiness([
      { rowKind: "pending_candidate", candidateKind: "ambiguous", financeRowCount: 2 },
      { rowKind: "pending_candidate", candidateKind: "new", financeRowCount: 1 },
      { rowKind: "pending_candidate", candidateKind: "existing_payment", financeRowCount: 1 },
    ])).toEqual({
      readyLineages: 0, readyIosLineages: 0, readyBankTransferLineages: 0,
      alreadyPostedLineages: 0, blockedRows: 2, ambiguousRows: 2,
    });
  });

  it("summarizes a mixed batch of lineages and pending candidates", () => {
    const rows: FinancePostingReadinessRow[] = [
      { rowKind: "lineage", status: "ready", financePaymentMethod: "ios" },
      { rowKind: "lineage", status: "already_posted", financePaymentMethod: "bank_transfer" },
      { rowKind: "lineage", status: "represented", financePaymentMethod: "bank_transfer" },
      { rowKind: "lineage", status: "blocked", financePaymentMethod: null },
      { rowKind: "pending_candidate", candidateKind: "ambiguous", financeRowCount: 2 },
      { rowKind: "pending_candidate", candidateKind: "existing_payment", financeRowCount: 1 },
    ];

    expect(summarizeFinancePostingReadiness(rows)).toEqual({
      readyLineages: 1, readyIosLineages: 1, readyBankTransferLineages: 0,
      alreadyPostedLineages: 2, blockedRows: 2, ambiguousRows: 2,
    });
  });
});
