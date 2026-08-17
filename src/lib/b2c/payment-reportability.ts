/**
 * The shared B2C reporting gate. Source records always remain visible, but a
 * payment cannot enter a financial total until it passes every approved rule.
 */
export type B2cPaymentReportabilityInput = {
  paymentStatus: "succeeded" | "failed" | "pending";
  customerEmail: string | null;
  categoryCode: string | null;
  openFlagTypes: ReadonlySet<string>;
  /** A null value means no Finance-approved USD source or local conversion exists yet. */
  originalCurrency?: string | null;
  amountUsd?: string | null;
  /** A separately audited, Admin-confirmed local inclusion decision. */
  hasFinanceException?: boolean;
  /** Immutable provenance from the approved Finance Payment Tracker posting path. */
  isApprovedFinancePayment?: boolean;
  /** Source follow-up problems other than the explicitly permitted missing-email exception. */
  hasBlockingNeedsFollowUp?: boolean;
};

export type B2cPaymentExclusionReason =
  | "not_succeeded"
  | "missing_customer_email"
  | "unmapped_product"
  | "possible_duplicate"
  | "needs_follow_up"
  | "needs_fx_review";

export function b2cPaymentExclusionReasons(input: B2cPaymentReportabilityInput): B2cPaymentExclusionReason[] {
  const reasons: B2cPaymentExclusionReason[] = [];
  const exceptionApproved = input.hasFinanceException === true;
  const approvedFinancePayment = input.isApprovedFinancePayment === true;
  if (input.amountUsd === null) reasons.push("needs_fx_review");
  if (input.paymentStatus !== "succeeded") reasons.push("not_succeeded");
  if (!input.customerEmail && !exceptionApproved && !approvedFinancePayment) reasons.push("missing_customer_email");
  if ((!input.categoryCode || input.categoryCode === "unmapped" || input.openFlagTypes.has("unmapped_product")) && !exceptionApproved) reasons.push("unmapped_product");
  if (input.openFlagTypes.has("possible_duplicate")) reasons.push("possible_duplicate");
  if (input.hasBlockingNeedsFollowUp ?? input.openFlagTypes.has("needs_follow_up")) reasons.push("needs_follow_up");
  return reasons;
}

export function isReportableB2cPayment(input: B2cPaymentReportabilityInput): boolean {
  return b2cPaymentExclusionReasons(input).length === 0;
}
