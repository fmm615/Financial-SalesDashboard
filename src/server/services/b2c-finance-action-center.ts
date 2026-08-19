export type B2cFinanceSourceTab = "B2C" | "B2C Cons";

/** The safe workbook facts Finance needs to review a current B2C decision. */
export type B2cFinanceSourceEvidence = {
  financeRowId: string;
  sourceTab: B2cFinanceSourceTab;
  sourceRowNumber: number;
  reportedDateRaw: string;
  declaredMonth: string | null;
  declaredYear: string | null;
  occurredOn: string | null;
  amountUsd: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  category: string | null;
  membershipType: string | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
  note: string | null;
  qualityIssues: string[];
};

export type B2cFinanceDuplicateCandidate = {
  groupId: string;
  state: "exact_duplicate_candidate";
  rows: B2cFinanceSourceEvidence[];
};

export type B2cFinanceCanonicalRecommendation = {
  groupId: string;
  sourceTab: B2cFinanceSourceTab | null;
  canonicalFinanceRowId: string | null;
  eligibleForBulk: boolean;
  winningCompleteness: number;
  otherCompleteness: number;
};

export type B2cFinanceNeedsReviewRow = B2cFinanceSourceEvidence;

export type B2cFinanceActionCenterRepository = {
  listPendingExactDuplicateGroups(): Promise<B2cFinanceDuplicateCandidate[]>;
  listNeedsReviewRows(): Promise<B2cFinanceNeedsReviewRow[]>;
  countPostedFinancePayments(): Promise<number>;
  getFinancePostingReadinessRows(): Promise<FinancePostingReadinessRow[]>;
};

/** A safe, plain-language summary of what the approved-Finance posting action would do next. */
export type FinancePostingReadiness = {
  readyLineages: number;
  readyIosLineages: number;
  readyBankTransferLineages: number;
  alreadyPostedLineages: number;
  blockedRows: number;
  ambiguousRows: number;
};

export type FinancePostingReadinessRow =
  | { rowKind: "lineage"; status: "ready" | "already_posted" | "represented" | "blocked"; financePaymentMethod: "ios" | "bank_transfer" | null }
  | { rowKind: "pending_candidate"; candidateKind: "new" | "ambiguous" | "existing_payment"; financeRowCount: number };

/**
 * Summarizes lineage posting-readiness rows into the counts the Ready-to-post
 * panel shows. A lineage already represented by a manual bank transfer, or
 * one that already has a posted Finance payment, is grouped with
 * `alreadyPostedLineages` -- from an Admin's perspective both mean "Finance
 * already has this recorded, nothing to post" even though the underlying RPC
 * keeps them in separate internal buckets. A pending import-version candidate
 * is never itself postable: an `ambiguous` candidate is a repeated identity
 * needing a specific decision, while `new`/`existing_payment` candidates are
 * simply awaiting the Admin's routine confirm/link decision.
 */
export function summarizeFinancePostingReadiness(rows: FinancePostingReadinessRow[]): FinancePostingReadiness {
  const summary: FinancePostingReadiness = {
    readyLineages: 0,
    readyIosLineages: 0,
    readyBankTransferLineages: 0,
    alreadyPostedLineages: 0,
    blockedRows: 0,
    ambiguousRows: 0,
  };

  for (const row of rows) {
    if (row.rowKind === "lineage") {
      if (row.status === "ready") {
        summary.readyLineages += 1;
        if (row.financePaymentMethod === "ios") summary.readyIosLineages += 1;
        if (row.financePaymentMethod === "bank_transfer") summary.readyBankTransferLineages += 1;
      } else if (row.status === "already_posted" || row.status === "represented") {
        summary.alreadyPostedLineages += 1;
      } else {
        summary.blockedRows += 1;
      }
    } else if (row.candidateKind === "ambiguous") {
      summary.ambiguousRows += row.financeRowCount;
    } else {
      summary.blockedRows += row.financeRowCount;
    }
  }

  return summary;
}

export type B2cFinanceActionItem = {
  id: string;
  actionType: "duplicate" | "date_authority" | "correction";
  actionLabel: string;
  explanation: string;
  sourceTab: B2cFinanceSourceTab | null;
  sourceRowNumber: number | null;
  evidence?: B2cFinanceSourceEvidence;
};

export type B2cFinanceActionOverview = {
  counts: {
    duplicateDecisions: number;
    duplicateSourceRows: number;
    bulkEligibleDuplicateDecisions: number;
    dateAuthorityActions: number;
    correctionActions: number;
    postedFinancePayments: number;
    postingReadiness: FinancePostingReadiness;
  };
  duplicateGroups: Array<B2cFinanceDuplicateCandidate & { recommendation: B2cFinanceCanonicalRecommendation }>;
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
      const [duplicateGroups, needsReviewRows, postedFinancePayments, postingReadinessRows] = await Promise.all([
        repository.listPendingExactDuplicateGroups(),
        repository.listNeedsReviewRows(),
        repository.countPostedFinancePayments(),
        repository.getFinancePostingReadinessRows(),
      ]);
      const postingReadiness = summarizeFinancePostingReadiness(postingReadinessRows);
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
          evidence: row,
        })),
        ...correctionRows.map((row) => ({
          id: `correction:${row.financeRowId}`,
          actionType: "correction" as const,
          actionLabel: "Correct verified information",
          explanation: correctionExplanation(row),
          sourceTab: row.sourceTab,
          sourceRowNumber: row.sourceRowNumber,
          evidence: row,
        })),
      ];

      return {
        counts: {
          duplicateDecisions: duplicateGroups.length,
          duplicateSourceRows: duplicateGroups.length * 2,
          bulkEligibleDuplicateDecisions: recommendations.filter((recommendation) => recommendation.eligibleForBulk).length,
          dateAuthorityActions: dateAuthorityRows.length,
          correctionActions: correctionRows.length,
          postedFinancePayments,
          postingReadiness,
        },
        duplicateGroups: duplicateGroups.map((group, index) => ({ ...group, recommendation: recommendations[index] })),
        items,
      };
    },
  };
}
