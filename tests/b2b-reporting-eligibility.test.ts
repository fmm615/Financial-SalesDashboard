import { describe, expect, it } from "vitest";
import { isB2bDealReportable } from "@/lib/b2b/reporting-eligibility";
import { buildB2bPipelineByStage, calculateB2bWinRate, resolveB2bReportingPeriod } from "@/server/repositories/b2b-dashboard-repository";

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
    expect(resolveB2bReportingPeriod("all", new Date("2026-08-03T00:00:00.000Z"))).toMatchObject({ month: "all", monthLabel: "All time", quarterLabel: "All time", isAllTime: true });
  });

  it("groups only reportable open pipeline value by stage", () => {
    expect(buildB2bPipelineByStage([
      { stageCode: "proposal", amountUsd: "50000" },
      { stageCode: "proposal", amountUsd: "12000.50" },
      { stageCode: "qualified", amountUsd: "7500" },
      { stageCode: "closed_won", amountUsd: "90000" },
      { stageCode: "closed_lost", amountUsd: "40000" },
      { stageCode: "discovery", amountUsd: null },
    ])).toEqual([
      { stage: "proposal", dealCount: 2, amountUsd: "$62,000.50" },
      { stage: "qualified", dealCount: 1, amountUsd: "$7,500.00" },
    ]);
  });

  it("calculates win rate only from closed decisions with a close date in the selected month", () => {
    expect(calculateB2bWinRate([
      { stageCode: "closed_won", closeDate: "2024-08-03" },
      { stageCode: "closed_won", closeDate: "2024-08-20" },
      { stageCode: "closed_lost", closeDate: "2024-08-29" },
      { stageCode: "closed_lost", closeDate: null },
      { stageCode: "closed_won", closeDate: "2024-07-31" },
      { stageCode: "proposal", closeDate: "2024-08-14" },
    ], { monthStart: "2024-08-01", monthEnd: "2024-08-31" })).toEqual({ percentage: "66.7%", wonCount: 2, lostCount: 1 });
  });

});
