import type {
  B2cPaymentDuplicateGroupRow,
  B2cPaymentDuplicateRepository,
} from "@/server/repositories/b2c-payment-duplicate-repository";

export type B2cPaymentDuplicateMemberReview = {
  paymentId: string;
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";
  providerReference: string | null;
  customerName: string | null;
  sourceCustomerEmail: string | null;
  effectiveCustomerEmail: string;
  sourceAmount: string;
  sourceCurrency: string;
  effectiveAmountUsd: string;
  sourceCategoryCode: string | null;
  effectiveCategoryCode: string;
  sourceOccurredOn: string | null;
  effectiveOccurredOn: string;
};

export type B2cPaymentDuplicateGroupReview = {
  groupId: string;
  detectionReason: string;
  members: B2cPaymentDuplicateMemberReview[];
};

export type B2cPaymentDuplicateReviewResult =
  | { kind: "group"; group: B2cPaymentDuplicateGroupReview }
  | { kind: "ungrouped_flag"; flagId: string }
  | { kind: "none" };

function requireComparisonFact(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new Error("The B2C payment duplicate group is malformed.");
  }
  return value;
}

export function toB2cPaymentDuplicateGroupReview(
  row: B2cPaymentDuplicateGroupRow,
): B2cPaymentDuplicateGroupReview {
  const members = row.members.map(({ payment_id: memberPaymentId, payment }) => {
    if (!payment || payment.id !== memberPaymentId) {
      throw new Error("The B2C payment duplicate group is malformed.");
    }

    return {
      paymentId: payment.id,
      sourceSystem: payment.source_system,
      providerReference: payment.provider_transaction_id,
      customerName: payment.local_override?.customer_name ?? payment.customer_name,
      sourceCustomerEmail: payment.customer_email,
      effectiveCustomerEmail: requireComparisonFact(
        payment.local_override?.customer_email ?? payment.customer_email,
      ),
      sourceAmount: payment.original_amount,
      sourceCurrency: payment.original_currency,
      effectiveAmountUsd: requireComparisonFact(
        payment.local_override?.local_amount_usd ?? payment.amount_usd,
      ),
      sourceCategoryCode: payment.category_code,
      effectiveCategoryCode: requireComparisonFact(
        payment.local_override?.category_code ?? payment.category_code,
      ),
      sourceOccurredOn: payment.occurred_on,
      effectiveOccurredOn: requireComparisonFact(
        payment.local_override?.local_occurred_on ?? payment.occurred_on,
      ),
    } satisfies B2cPaymentDuplicateMemberReview;
  }).sort((left, right) => (
    left.effectiveOccurredOn.localeCompare(right.effectiveOccurredOn)
    || left.paymentId.localeCompare(right.paymentId)
  ));

  return {
    groupId: row.id,
    detectionReason: row.detection_reason,
    members,
  };
}

export async function getB2cPaymentDuplicateReview(
  paymentId: string,
  repository: B2cPaymentDuplicateRepository,
): Promise<B2cPaymentDuplicateReviewResult> {
  const group = await repository.getOpenGroupForPayment(paymentId);
  if (group) return { kind: "group", group: toB2cPaymentDuplicateGroupReview(group) };

  const flag = await repository.getOpenPossibleDuplicateFlagForPayment(paymentId);
  return flag ? { kind: "ungrouped_flag", flagId: flag.id } : { kind: "none" };
}
