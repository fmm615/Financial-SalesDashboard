/**
 * A local correction is an overlay for PLAYBOOK reporting. It must never
 * mutate the provider source row, so callers always receive a new effective
 * view built from the source values and the optional local override.
 */
export type B2cPaymentSourceValues = {
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  categoryCode: string | null;
  membershipTier: string | null;
  amountUsd: string;
  occurredOn: string;
};

export type B2cPaymentLocalOverrideValues = {
  [Field in keyof B2cPaymentSourceValues]?: B2cPaymentSourceValues[Field] | null;
};

export type B2cEffectivePayment = B2cPaymentSourceValues & {
  hasLocalCorrection: boolean;
  correctedFields: Array<keyof B2cPaymentSourceValues>;
};

export function resolveEffectiveB2cPayment(
  source: B2cPaymentSourceValues,
  override: B2cPaymentLocalOverrideValues | null | undefined,
): B2cEffectivePayment {
  const correctedFields = (Object.keys(source) as Array<keyof B2cPaymentSourceValues>).filter((field) => override?.[field] !== null && override?.[field] !== undefined);

  return {
    customerName: override?.customerName ?? source.customerName,
    customerEmail: override?.customerEmail ?? source.customerEmail,
    customerPhone: override?.customerPhone ?? source.customerPhone,
    categoryCode: override?.categoryCode ?? source.categoryCode,
    membershipTier: override?.membershipTier ?? source.membershipTier,
    amountUsd: override?.amountUsd ?? source.amountUsd,
    occurredOn: override?.occurredOn ?? source.occurredOn,
    hasLocalCorrection: correctedFields.length > 0,
    correctedFields,
  };
}
