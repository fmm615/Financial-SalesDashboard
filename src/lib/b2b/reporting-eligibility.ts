export type B2bReportingEligibilityInput = {
  financialStatus: "complete" | "needs_review";
  duplicateReviewStatus: "clear" | "needs_review" | "include" | "exclude";
  stageCode: string;
  closeDate: string | null;
};

/**
 * A deal may be retained locally for traceability without being safe to show
 * in operational or financial views. Keep that safety rule in one place.
 */
export function isB2bDealReportable(deal: B2bReportingEligibilityInput): boolean {
  if (deal.financialStatus !== "complete") return false;
  if (deal.duplicateReviewStatus !== "clear" && deal.duplicateReviewStatus !== "include") return false;
  return deal.stageCode !== "closed_won" || deal.closeDate !== null;
}
