export type B2cFinanceSourceTab = "B2C" | "B2C Cons";

export type B2cFinanceDuplicateCandidate = {
  groupId: string;
  state: "exact_duplicate_candidate";
  rows: Array<{
    financeRowId: string;
    sourceTab: B2cFinanceSourceTab;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    category: string | null;
    membershipType: string | null;
    paymentStatus: string | null;
    note: string | null;
  }>;
};

export type B2cFinanceCanonicalRecommendation = {
  groupId: string;
  sourceTab: B2cFinanceSourceTab | null;
  canonicalFinanceRowId: string | null;
  eligibleForBulk: boolean;
  winningCompleteness: number;
  otherCompleteness: number;
};

export type B2cFinanceNeedsReviewRow = {
  financeRowId: string;
  sourceTab: B2cFinanceSourceTab;
  sourceRowNumber: number;
  occurredOn: string | null;
  qualityIssues: string[];
};

export type B2cFinanceActionCenterRepository = {
  listPendingExactDuplicateGroups(): Promise<B2cFinanceDuplicateCandidate[]>;
  listNeedsReviewRows(): Promise<B2cFinanceNeedsReviewRow[]>;
};

export type B2cFinanceActionItem = {
  id: string;
  actionType: "duplicate" | "date_authority" | "correction";
  actionLabel: string;
  explanation: string;
  sourceTab: B2cFinanceSourceTab | null;
  sourceRowNumber: number | null;
};

export type B2cFinanceActionOverview = {
  counts: {
    duplicateDecisions: number;
    duplicateSourceRows: number;
    bulkEligibleDuplicateDecisions: number;
    dateAuthorityActions: number;
    correctionActions: number;
  };
  items: B2cFinanceActionItem[];
};

const hasValue = (value: string | null) => Boolean(value?.trim());

function completeness(row: B2cFinanceDuplicateCandidate["rows"][number]): number {
  return [
    row.customerName,
    row.customerEmail,
    row.customerPhone,
    row.category,
    row.membershipType,
    row.paymentStatus,
    row.note,
  ].filter(hasValue).length;
}

/**
 * Recommends a source only when the exact pair is structurally safe and one
 * record is provably more complete. Ties always stay for individual review.
 */
export function getCanonicalRecommendation(group: B2cFinanceDuplicateCandidate): B2cFinanceCanonicalRecommendation {
  if (group.state !== "exact_duplicate_candidate" || group.rows.length !== 2) {
    return { groupId: group.groupId, sourceTab: null, canonicalFinanceRowId: null, eligibleForBulk: false, winningCompleteness: 0, otherCompleteness: 0 };
  }

  const b2c = group.rows.find((row) => row.sourceTab === "B2C");
  const b2cCons = group.rows.find((row) => row.sourceTab === "B2C Cons");
  if (!b2c || !b2cCons) {
    return { groupId: group.groupId, sourceTab: null, canonicalFinanceRowId: null, eligibleForBulk: false, winningCompleteness: 0, otherCompleteness: 0 };
  }

  const b2cCompleteness = completeness(b2c);
  const b2cConsCompleteness = completeness(b2cCons);
  if (b2cCompleteness === b2cConsCompleteness) {
    return { groupId: group.groupId, sourceTab: null, canonicalFinanceRowId: null, eligibleForBulk: false, winningCompleteness: b2cCompleteness, otherCompleteness: b2cConsCompleteness };
  }

  const winner = b2cCompleteness > b2cConsCompleteness ? b2c : b2cCons;
  const loserCompleteness = b2cCompleteness > b2cConsCompleteness ? b2cConsCompleteness : b2cCompleteness;
  return {
    groupId: group.groupId,
    sourceTab: winner.sourceTab,
    canonicalFinanceRowId: winner.financeRowId,
    eligibleForBulk: true,
    winningCompleteness: completeness(winner),
    otherCompleteness: loserCompleteness,
  };
}

function isDateAuthorityCandidate(row: B2cFinanceNeedsReviewRow): boolean {
  const dateOnlyIssues = new Set(["declared_month_conflicts_with_date", "declared_year_conflicts_with_date"]);
  return Boolean(row.occurredOn) && row.qualityIssues.length > 0 && row.qualityIssues.every((issue) => dateOnlyIssues.has(issue));
}

function correctionExplanation(row: B2cFinanceNeedsReviewRow): string {
  if (row.qualityIssues.includes("missing_name")) return "The workbook row has no customer name. Enter the verified name from Finance evidence.";
  if (row.qualityIssues.includes("unreadable_date")) return "The workbook date cannot be read. Enter the verified Finance date.";
  return "This workbook row has information Finance must verify before it can be used.";
}

/** Converts source states into plain-language actions without exposing contact or payment evidence. */
export function createB2cFinanceActionCenter(repository: B2cFinanceActionCenterRepository) {
  return {
    async overview(): Promise<B2cFinanceActionOverview> {
      const [duplicateGroups, needsReviewRows] = await Promise.all([
        repository.listPendingExactDuplicateGroups(),
        repository.listNeedsReviewRows(),
      ]);
      const recommendations = duplicateGroups.map(getCanonicalRecommendation);
      const dateAuthorityRows = needsReviewRows.filter(isDateAuthorityCandidate);
      const correctionRows = needsReviewRows.filter((row) => !isDateAuthorityCandidate(row));
      const items: B2cFinanceActionItem[] = [
        ...recommendations.map((recommendation) => ({
          id: `duplicate:${recommendation.groupId}`,
          actionType: "duplicate" as const,
          actionLabel: recommendation.eligibleForBulk ? `Keep the fuller ${recommendation.sourceTab} record` : "Choose which record to keep",
          explanation: recommendation.eligibleForBulk
            ? "The two workbook rows are an exact duplicate. One record has more usable Finance information."
            : "The duplicate records are equally complete, so Finance must choose one individually.",
          sourceTab: recommendation.sourceTab,
          sourceRowNumber: null,
        })),
        ...dateAuthorityRows.map((row) => ({
          id: `date-authority:${row.financeRowId}`,
          actionType: "date_authority" as const,
          actionLabel: "Use the verified Date",
          explanation: "The Date is valid, but the Month or Year label conflicts with it. Keep the Date as the financial record.",
          sourceTab: row.sourceTab,
          sourceRowNumber: row.sourceRowNumber,
        })),
        ...correctionRows.map((row) => ({
          id: `correction:${row.financeRowId}`,
          actionType: "correction" as const,
          actionLabel: "Correct verified information",
          explanation: correctionExplanation(row),
          sourceTab: row.sourceTab,
          sourceRowNumber: row.sourceRowNumber,
        })),
      ];

      return {
        counts: {
          duplicateDecisions: duplicateGroups.length,
          duplicateSourceRows: duplicateGroups.length * 2,
          bulkEligibleDuplicateDecisions: recommendations.filter((recommendation) => recommendation.eligibleForBulk).length,
          dateAuthorityActions: dateAuthorityRows.length,
          correctionActions: correctionRows.length,
        },
        items,
      };
    },
  };
}
