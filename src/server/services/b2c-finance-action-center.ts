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
