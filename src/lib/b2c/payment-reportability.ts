/**
 * The shared B2C reporting gate. Source records always remain visible, but a
 * payment cannot enter a financial total until it passes every approved rule.
 */
export type B2cPaymentReportabilityInput = {
  paymentStatus: "succeeded" | "failed" | "pending";
  customerEmail: string | null;
  categoryCode: string | null;
  openFlagTypes: ReadonlySet<string>;
};

export type B2cPaymentExclusionReason =
  | "not_succeeded"
  | "missing_customer_email"
  | "unmapped_product"
  | "possible_duplicate"
  | "needs_follow_up";

export function b2cPaymentExclusionReasons(input: B2cPaymentReportabilityInput): B2cPaymentExclusionReason[] {
  const reasons: B2cPaymentExclusionReason[] = [];
  if (input.paymentStatus !== "succeeded") reasons.push("not_succeeded");
  if (!input.customerEmail) reasons.push("missing_customer_email");
  if (!input.categoryCode || input.categoryCode === "unmapped" || input.openFlagTypes.has("unmapped_product")) reasons.push("unmapped_product");
  if (input.openFlagTypes.has("possible_duplicate")) reasons.push("possible_duplicate");
  if (input.openFlagTypes.has("needs_follow_up")) reasons.push("needs_follow_up");
  return reasons;
}

export function isReportableB2cPayment(input: B2cPaymentReportabilityInput): boolean {
  return b2cPaymentExclusionReasons(input).length === 0;
}
