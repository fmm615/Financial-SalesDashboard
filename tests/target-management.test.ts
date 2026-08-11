import { describe, expect, it } from "vitest";
import {
  financialTargetSchema,
  operationalProgressSchema,
  operationalTargetSchema,
} from "@/lib/validation/target-contracts";

describe("target-management contracts", () => {
  it("accepts only an approved financial metric with a decimal USD goal", () => {
    const target = {
      metricCode: "b2c_cash_received",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      targetAmountUsd: "500000.250000",
      status: "active",
      financeReference: "FY26 Finance plan",
      revisionReason: "Approved annual target",
    };

    expect(financialTargetSchema.safeParse(target).success).toBe(true);
    expect(financialTargetSchema.safeParse({ ...target, metricCode: "sales" }).success).toBe(false);
    expect(financialTargetSchema.safeParse({ ...target, targetAmountUsd: 500000.25 }).success).toBe(false);
  });

  it("requires a unit for a quantity target and rejects it for a USD target", () => {
    const quantityTarget = {
      displayName: "Summit tickets",
      valueKind: "quantity",
      targetValue: "100",
      unitLabel: "tickets",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      status: "active",
      financeReference: "Summit plan",
      revisionReason: "Approved operational target",
    };

    expect(operationalTargetSchema.safeParse(quantityTarget).success).toBe(true);
    expect(operationalTargetSchema.safeParse({ ...quantityTarget, unitLabel: undefined }).success).toBe(false);
    expect(operationalTargetSchema.safeParse({ ...quantityTarget, valueKind: "money_usd" }).success).toBe(false);
  });

  it("requires a dated evidence note for manual operational progress", () => {
    const update = {
      targetId: "11111111-1111-4111-8111-111111111111",
      actualValue: "42",
      effectiveOn: "2026-08-11",
      evidenceNote: "Ticketing report reconciled by Operations",
    };

    expect(operationalProgressSchema.safeParse(update).success).toBe(true);
    expect(operationalProgressSchema.safeParse({ ...update, evidenceNote: " " }).success).toBe(false);
  });
});
