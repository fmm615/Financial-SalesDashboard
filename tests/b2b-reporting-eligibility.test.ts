import { describe, expect, it } from "vitest";
import { isB2bDealReportable } from "@/lib/b2b/reporting-eligibility";
import { resolveB2bReportingPeriod } from "@/server/repositories/b2b-dashboard-repository";

describe("B2B reporting eligibility", () => {
  it("excludes incomplete and unresolved-duplicate deals from all reportable views", () => {
    expect(isB2bDealReportable({ financialStatus: "needs_review", duplicateReviewStatus: "clear", stageCode: "qualified", closeDate: null })).toBe(false);
    expect(isB2bDealReportable({ financialStatus: "complete", duplicateReviewStatus: "needs_review", stageCode: "qualified", closeDate: null })).toBe(false);
  });

  it("excludes a closed-won deal until an Admin supplies a known local close date", () => {
    expect(isB2bDealReportable({ financialStatus: "complete", duplicateReviewStatus: "clear", stageCode: "closed_won", closeDate: null })).toBe(false);
    expect(isB2bDealReportable({ financialStatus: "complete", duplicateReviewStatus: "clear", stageCode: "closed_won", closeDate: "2026-08-02" })).toBe(true);
  });

  it("includes complete non-duplicate pipeline deals without inventing a close date", () => {
    expect(isB2bDealReportable({ financialStatus: "complete", duplicateReviewStatus: "include", stageCode: "proposal", closeDate: null })).toBe(true);
  });

  it("uses the selected month for financial period labels and its containing quarter", () => {
    expect(resolveB2bReportingPeriod("2024-08", new Date("2026-08-03T00:00:00.000Z"))).toMatchObject({
      month: "2024-08", monthLabel: "August 2024", quarterLabel: "Q3 2024",
      monthStart: "2024-08-01", monthEnd: "2024-08-31", quarterStart: "2024-07-01", quarterEnd: "2024-09-30",
    });
  });
});
