import { describe, expect, it } from "vitest";
import {
  b2cPaymentDuplicateDecisionSchema,
  b2cPaymentDuplicateStaleDismissalSchema,
} from "@/lib/validation/b2c-payment-duplicate-contracts";
import {
  toB2cPaymentDuplicateGroupReview,
} from "@/server/services/b2c-payment-duplicate-review";

const paymentIdA = "11111111-1111-4111-8111-111111111111";
const paymentIdB = "22222222-2222-4222-8222-222222222222";

describe("B2C payment duplicate decision contracts", () => {
  it("accepts a keep-one decision with one canonical payment and a meaningful reason", () => {
    expect(b2cPaymentDuplicateDecisionSchema.safeParse({
      decision: "keep_one",
      canonicalPaymentId: paymentIdA,
      reason: "Finance verified the retained provider receipt.",
    }).success).toBe(true);
  });

  it("rejects placeholder reasons", () => {
    expect(b2cPaymentDuplicateDecisionSchema.safeParse({
      decision: "keep_all",
      canonicalPaymentId: null,
      reason: "---",
    }).success).toBe(false);

    expect(b2cPaymentDuplicateStaleDismissalSchema.safeParse({ reason: "n/a" }).success).toBe(false);
  });

  it("rejects a canonical payment for keep-all", () => {
    expect(b2cPaymentDuplicateDecisionSchema.safeParse({
      decision: "keep_all",
      canonicalPaymentId: paymentIdA,
      reason: "Both receipts are separate payments.",
    }).success).toBe(false);
  });

  it("rejects missing canonical payments and unknown request fields", () => {
    expect(b2cPaymentDuplicateDecisionSchema.safeParse({
      decision: "keep_one",
      canonicalPaymentId: null,
      reason: "Finance verified the retained provider receipt.",
    }).success).toBe(false);
    expect(b2cPaymentDuplicateDecisionSchema.safeParse({
      decision: "keep_all",
      canonicalPaymentId: null,
      reason: "Both receipts are separate payments.",
      actorEmail: "admin@playbook.test",
    }).success).toBe(false);
  });
});

describe("B2C payment duplicate review mapping", () => {
  it("returns stable UI-safe source and effective facts without private nested data", () => {
    const review = toB2cPaymentDuplicateGroupReview({
      id: "33333333-3333-4333-8333-333333333333",
      detection_reason: "Matching verified payment facts within 48 hours.",
      members: [
        {
          payment_id: paymentIdA,
          payment: {
            id: paymentIdA,
            source_system: "stripe",
            provider_transaction_id: "ch_safe_reference",
            customer_name: "Source A",
            customer_email: "source-a@playbook.test",
            original_amount: "110.000000",
            original_currency: "USD",
            amount_usd: "110.000000",
            occurred_on: "2026-08-22",
            payment_status: "succeeded",
            source_metadata: { secret: "must-not-leak" },
            stripeEvidence: { raw: true },
            auditActorEmail: "actor@playbook.test",
            raw_payload: { private: true },
            local_override: {
              customer_name: "Effective A",
              customer_email: "effective-a@playbook.test",
              local_amount_usd: "125.000000",
              local_occurred_on: "2026-08-23",
              before_value: { private: true },
              actor_email: "actor@playbook.test",
            },
          },
        },
        {
          payment_id: paymentIdB,
          payment: {
            id: paymentIdB,
            source_system: "tap",
            provider_transaction_id: null,
            customer_name: null,
            customer_email: "source-b@playbook.test",
            original_amount: "125.000000",
            original_currency: "USD",
            amount_usd: "125.000000",
            occurred_on: "2026-08-23",
            payment_status: "succeeded",
            local_override: null,
          },
        },
      ],
    } as never);

    expect(review).toEqual({
      groupId: "33333333-3333-4333-8333-333333333333",
      detectionReason: "Matching verified payment facts within 48 hours.",
      members: [
        {
          paymentId: paymentIdA,
          sourceSystem: "stripe",
          providerReference: "ch_safe_reference",
          customerName: "Effective A",
          sourceCustomerEmail: "source-a@playbook.test",
          effectiveCustomerEmail: "effective-a@playbook.test",
          sourceAmount: "110.000000",
          sourceCurrency: "USD",
          effectiveAmountUsd: "125.000000",
          sourceOccurredOn: "2026-08-22",
          effectiveOccurredOn: "2026-08-23",
        },
        {
          paymentId: paymentIdB,
          sourceSystem: "tap",
          providerReference: null,
          customerName: null,
          sourceCustomerEmail: "source-b@playbook.test",
          effectiveCustomerEmail: "source-b@playbook.test",
          sourceAmount: "125.000000",
          sourceCurrency: "USD",
          effectiveAmountUsd: "125.000000",
          sourceOccurredOn: "2026-08-23",
          effectiveOccurredOn: "2026-08-23",
        },
      ],
    });

    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("source_metadata");
    expect(serialized).not.toContain("stripeEvidence");
    expect(serialized).not.toContain("actor@playbook.test");
    expect(serialized).not.toContain("raw_payload");
    expect(serialized).not.toContain("local_override");
  });

  it("sorts members by effective date and then payment ID", () => {
    const review = toB2cPaymentDuplicateGroupReview({
      id: "33333333-3333-4333-8333-333333333333",
      detection_reason: "Matching verified payment facts within 48 hours.",
      members: [
        {
          payment_id: paymentIdB,
          payment: {
            id: paymentIdB,
            source_system: "tap",
            provider_transaction_id: null,
            customer_name: null,
            customer_email: "member@playbook.test",
            original_amount: "125.000000",
            original_currency: "USD",
            amount_usd: "125.000000",
            occurred_on: "2026-08-23",
            payment_status: "succeeded",
            local_override: null,
          },
        },
        {
          payment_id: paymentIdA,
          payment: {
            id: paymentIdA,
            source_system: "manual_bank_transfer",
            provider_transaction_id: "bank-1",
            customer_name: "Member",
            customer_email: "member@playbook.test",
            original_amount: "125.000000",
            original_currency: "USD",
            amount_usd: "125.000000",
            occurred_on: "2026-08-23",
            payment_status: "succeeded",
            local_override: null,
          },
        },
      ],
    });

    expect(review.members.map((member) => member.paymentId)).toEqual([paymentIdA, paymentIdB]);
  });

  it("fails closed when a member is missing an effective comparison fact", () => {
    expect(() => toB2cPaymentDuplicateGroupReview({
      id: "33333333-3333-4333-8333-333333333333",
      detection_reason: "Matching verified payment facts within 48 hours.",
      members: [{
        payment_id: paymentIdA,
        payment: {
          id: paymentIdA,
          source_system: "stripe",
          provider_transaction_id: "ch_1",
          customer_name: "Member",
          customer_email: null,
          original_amount: "125.000000",
          original_currency: "USD",
          amount_usd: "125.000000",
          occurred_on: "2026-08-23",
          payment_status: "succeeded",
          local_override: null,
        },
      }],
    })).toThrow("malformed");
  });
});
