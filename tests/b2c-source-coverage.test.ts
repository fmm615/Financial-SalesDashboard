import { describe, expect, it } from "vitest";
import { resolveB2cSourceCoverage } from "@/lib/b2c/source-coverage";

describe("B2C source coverage", () => {
  it("withholds financial totals before historical Stripe data is fully loaded", () => {
    const coverage = resolveB2cSourceCoverage({
      providers: [{ provider: "stripe", active: true, historicalBackfill: { status: "processing", recordsFailed: 0, completedAt: null }, latestReconciliation: null }],
    });

    expect(coverage).toMatchObject({ reportingTotalsReady: false, state: "incomplete" });
  });

  it("withholds financial totals when the completed backfill has source failures", () => {
    const coverage = resolveB2cSourceCoverage({
      providers: [{ provider: "stripe", active: true, historicalBackfill: { status: "completed", recordsFailed: 2, completedAt: "2026-08-05T08:00:00.000Z" }, latestReconciliation: null }],
    });

    expect(coverage).toMatchObject({ reportingTotalsReady: false, state: "incomplete" });
    expect(coverage.description).toContain("2 source records");
  });

  it("makes financial totals available after a clean historical import and advances the as-of timestamp", () => {
    const coverage = resolveB2cSourceCoverage({
      providers: [{ provider: "stripe", active: true, historicalBackfill: { status: "completed", recordsFailed: 0, completedAt: "2026-08-05T08:00:00.000Z" }, latestReconciliation: { status: "completed", requestedRangeEnd: "2026-08-05T12:00:00.000Z", completedAt: "2026-08-05T12:01:00.000Z" } }],
    });

    expect(coverage).toMatchObject({ reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-05T12:00:00.000Z" });
  });
});
