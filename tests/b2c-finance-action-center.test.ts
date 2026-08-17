import { describe, expect, it } from "vitest";
import {
  getCanonicalRecommendation,
  type B2cFinanceDuplicateCandidate,
} from "@/server/services/b2c-finance-action-center";

const completeB2cConsPair: B2cFinanceDuplicateCandidate = {
  groupId: "11111111-1111-4111-8111-111111111111",
  state: "exact_duplicate_candidate",
  rows: [
    {
      financeRowId: "22222222-2222-4222-8222-222222222222",
      sourceTab: "B2C",
      customerName: "Reham Garash",
      customerEmail: null,
      customerPhone: null,
      category: "Membership",
      membershipType: null,
      paymentStatus: null,
      note: null,
    },
    {
      financeRowId: "33333333-3333-4333-8333-333333333333",
      sourceTab: "B2C Cons",
      customerName: "Reham Garash",
      customerEmail: "reham@example.com",
      customerPhone: "+973 3000 0000",
      category: "Membership",
      membershipType: "Female Founder Club",
      paymentStatus: "Received",
      note: "Full payment",
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
});
