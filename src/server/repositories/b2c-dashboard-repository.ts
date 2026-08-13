import { b2cPaymentExclusionReasons, isReportableB2cPayment } from "@/lib/b2c/payment-reportability";
import { resolveB2cSourceCoverage, type B2cSourceCoverage } from "@/lib/b2c/source-coverage";
import { resolveEffectiveB2cPayment } from "@/lib/b2c/effective-payment";
import type { DatabaseClient } from "@/lib/supabase/server";

const USD_SCALE = BigInt(1_000_000);

export type B2cReportingPeriod = { month: string; monthLabel: string; monthStart: string; monthEnd: string; isAllTime?: boolean };
export type B2cLedgerRow = {
  id: string;
  recordType: "Payment" | "Refund";
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerNameEvidenceLabel: StripeContactFallbackLabel;
  customerEmailEvidenceLabel: StripeContactFallbackLabel;
  customerPhoneEvidenceLabel: StripeContactFallbackLabel;
  date: string;
  dateValue: string;
  /** Displayed reporting amount when one exists, otherwise the retained source amount/currency. */
  amountUsd: string;
  /** USD-only numeric value used for USD filtering and sorting. */
  amountValueUsd: string | null;
  sourceAmountUsd: string;
  sourceOriginalAmount?: string;
  sourceOriginalCurrency?: string;
  foreignCurrencyReview?: boolean;
  sourceDateValue: string;
  category: string;
  membershipTier: string | null;
  billingInterval: string | null;
  source: string;
  paymentStatus: "Completed" | "Failed" | "Pending" | "Refunded";
  providerReference: string | null;
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer";
  productReference: string | null;
  hasLocalCorrection: boolean;
  localCorrectionFields: string[];
  hasFinanceException: boolean;
  openReviewFlags: B2cOpenReviewFlag[];
  issue: "Possible duplicate" | "Unmapped product" | "Failed" | "Missing customer email" | "Needs follow-up" | "Needs FX review" | "Refunded" | null;
  /** Safe, read-only Stripe evidence. It never participates in reportability. */
  stripeEvidence?: B2cStripeEvidence | null;
};
export type B2cStripeRefundEvidence = {
  refundId: string;
  originalAmount: string;
  originalCurrency: string;
  settlementRefundAmount: string | null;
  settlementCurrency: string | null;
  settlementExchangeRate: string | null;
};
export type B2cStripeEvidence = {
  originalAmount: string;
  originalCurrency: string;
  amountRefunded: string | null;
  description: string | null;
  sellerMessage: string | null;
  cardholderName: string | null;
  settlementGrossAmount: string | null;
  settlementFeeAmount: string | null;
  settlementFeeTaxAmount: string | null;
  settlementNetAmount: string | null;
  settlementCurrency: string | null;
  settlementExchangeRate: string | null;
  refunds: B2cStripeRefundEvidence[];
};
export type StripeContactFallbackLabel = "Stripe payment method" | "Stripe profile" | null;
export type B2cStripeContactFallback = {
  customerName: string | null; customerNameLabel: StripeContactFallbackLabel;
  customerEmail: string | null; customerEmailLabel: StripeContactFallbackLabel;
  customerPhone: string | null; customerPhoneLabel: StripeContactFallbackLabel;
};
export type B2cContactDisplay = B2cStripeContactFallback;
export type B2cDashboardSnapshot = {
  period: B2cReportingPeriod;
  sourceCoverage: B2cSourceCoverage;
  hasSourceRecords: boolean;
  eligiblePaymentsUsd: string;
  refundsUsd: string;
  netPaymentsUsd: string;
  completedSourcePaymentsUsd: string;
  sourceRefundsUsd: string;
  calculation: {
    completedSourcePaymentCount: number;
    reportablePaymentCount: number;
    excludedCompletedPaymentCount: number;
    excludedCompletedPaymentsUsd: string;
    sourceRefundCount: number;
    eligibleRefundCount: number;
    missingCustomerEmailCount: number;
    unmappedProductCount: number;
    possibleDuplicateCount: number;
    otherReviewCount: number;
    nonSucceededPaymentCount: number;
    financeExceptionPaymentCount: number;
  };
  reviewItems: number;
  rows: B2cLedgerRow[];
};

type Flag = { id: string; source_area: string; source_record_id: string; flag_type: string; reason: string };
type LocalPaymentOverride = {
  payment_id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  category_code: string | null;
  membership_tier: string | null;
  local_amount_usd: string | null;
  local_occurred_on: string | null;
};

type FinanceExceptionDecision = {
  payment_id: string;
  decision: "include" | "revoke";
  created_at: string;
  id: string;
};

type StripeEvidenceProjection = {
  payment_id: string;
  original_amount: string;
  original_currency: string;
  charge_refunded_amount: string | null;
  charge_description: string | null;
  seller_message: string | null;
  cardholder_name: string | null;
  settlement_gross_amount: string | null;
  settlement_fee_amount: string | null;
  settlement_fee_tax_amount: string | null;
  settlement_net_amount: string | null;
  settlement_currency: string | null;
  settlement_exchange_rate: string | null;
  refund_id: string | null;
  refund_original_amount: string | null;
  refund_original_currency: string | null;
  refund_settlement_amount: string | null;
  refund_settlement_currency: string | null;
  refund_settlement_exchange_rate: string | null;
};

export function resolveB2cContactDisplay(source: Pick<ReturnType<typeof resolveEffectiveB2cPayment>, "customerName" | "customerEmail" | "customerPhone" | "hasLocalCorrection" | "correctedFields">, fallback: B2cStripeContactFallback | null | undefined): B2cContactDisplay {
  return {
    customerName: source.customerName ?? fallback?.customerName ?? null,
    customerNameLabel: source.customerName ? null : fallback?.customerNameLabel ?? null,
    customerEmail: source.customerEmail ?? fallback?.customerEmail ?? null,
    customerEmailLabel: source.customerEmail ? null : fallback?.customerEmailLabel ?? null,
    customerPhone: source.customerPhone ?? fallback?.customerPhone ?? null,
    customerPhoneLabel: source.customerPhone ? null : fallback?.customerPhoneLabel ?? null,
  };
}

export type B2cOpenReviewFlag = {
  id: string;
  type: B2cLedgerRow["issue"] extends infer Issue ? Exclude<Issue, null> : never;
  reason: string;
};

function toScaledUsd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Stored B2C USD value is invalid.");
  return BigInt(match[1]) * USD_SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function formatUsd(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  const whole = absolute / USD_SCALE;
  const cents = (absolute % USD_SCALE) / BigInt(10_000);
  return `${value < BigInt(0) ? "−" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/** A source amount is not a USD figure unless Stripe actually supplied USD. */
function formatSourceAmount(value: string, currency: string, negative = false): string {
  if (currency === "USD") return formatUsd((negative ? -BigInt(1) : BigInt(1)) * toScaledUsd(value));
  return `${negative ? "−" : ""}${value} ${currency}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
}

function flagLabel(flags: Flag[]): B2cLedgerRow["issue"] {
  const types = new Set(flags.map((flag) => flag.flag_type));
  if (types.has("needs_follow_up") && flags.some((flag) => /missing a valid customer email/i.test(flag.reason))) return "Missing customer email";
  if (types.has("possible_duplicate")) return "Possible duplicate";
  if (types.has("unmapped_product")) return "Unmapped product";
  if (types.has("failed")) return "Failed";
  if (types.has("needs_follow_up")) return "Needs follow-up";
  if (types.has("refunded")) return "Refunded";
  return null;
}

function reviewFlagLabel(flag: Flag): Exclude<B2cLedgerRow["issue"], null> {
  if (flag.flag_type === "needs_fx_review") return "Needs FX review";
  return flagLabel([flag]) ?? "Needs follow-up";
}

function isMissingCustomerEmailFlag(flag: Flag): boolean {
  return flag.flag_type === "needs_follow_up" && /missing a valid customer email/i.test(flag.reason);
}

function displayPaymentStatus(status: "succeeded" | "failed" | "pending"): B2cLedgerRow["paymentStatus"] {
  if (status === "succeeded") return "Completed";
  if (status === "failed") return "Failed";
  return "Pending";
}

function sourceMetadataText(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function billingIntervalLabel(sourceMetadata: unknown): string | null {
  const interval = sourceMetadataText(sourceMetadata, "stripe_billing_interval");
  const count = Number(sourceMetadataText(sourceMetadata, "stripe_billing_interval_count") ?? "1");
  if (!interval || !Number.isInteger(count) || count < 1) return null;
  if (count === 1) {
    if (interval === "day") return "Daily";
    if (interval === "week") return "Weekly";
    if (interval === "month") return "Monthly";
    if (interval === "year") return "Annual";
    return null;
  }
  return ["day", "week", "month", "year"].includes(interval) ? `Every ${count} ${interval}s` : null;
}

export function resolveB2cReportingPeriod(selectedMonth: string | undefined, today = new Date()): B2cReportingPeriod {
  const fallback = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const isAllTime = selectedMonth === "all";
  const month = isAllTime ? "all" : /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth ?? "") ? selectedMonth! : fallback;
  const calculationMonth = isAllTime ? fallback : month;
  const [year, monthIndex] = calculationMonth.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex, 0));
  return {
    month,
    monthLabel: isAllTime ? "All time" : new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date),
    monthStart: date.toISOString().slice(0, 10),
    monthEnd: monthEnd.toISOString().slice(0, 10),
    isAllTime,
  };
}

function isInB2cPeriod(date: string, period: B2cReportingPeriod): boolean {
  return period.isAllTime || (date >= period.monthStart && date <= period.monthEnd);
}

/**
 * Produces a ledger-oriented B2C snapshot. A payment is reportable only when it
 * succeeded and has neither an open duplicate nor an unmapped-product flag.
 * Refunds remain separate source records and reduce only the net-payment metric.
 */
export async function getB2cDashboardSnapshot(client: DatabaseClient, today = new Date(), selectedMonth?: string): Promise<B2cDashboardSnapshot> {
  const period = resolveB2cReportingPeriod(selectedMonth, today);
  const [paymentsResult, refundsResult, paymentFlagsResult, refundFlagsResult, localOverridesResult, financeExceptionResult, stripeContactFallbacksResult, stripeEvidenceResult, stripeHistoricalResult, stripeReconciliationResult, tapHistoricalResult, tapReconciliationResult] = await Promise.all([
    client.from("b2c_payments").select("id,source_system,provider_transaction_id,customer_name,customer_email,customer_phone,category_code,membership_tier,payment_status,original_amount,original_currency,amount_usd,occurred_on,source_metadata").order("occurred_at", { ascending: false }),
    client.from("b2c_refunds").select("id,payment_id,source_system,provider_refund_id,original_amount,original_currency,amount_usd,occurred_at").order("occurred_at", { ascending: false }),
    client.from("review_flags").select("id,source_area,source_record_id,flag_type,reason").eq("source_area", "b2c_payment").eq("status", "open"),
    client.from("review_flags").select("id,source_area,source_record_id,flag_type,reason").eq("source_area", "b2c_refund").eq("status", "open"),
    client.from("b2c_payment_local_overrides").select("payment_id,customer_name,customer_email,customer_phone,category_code,membership_tier,local_amount_usd,local_occurred_on"),
    client.from("b2c_payment_finance_exception_decisions").select("id,payment_id,decision,created_at").order("created_at", { ascending: false }),
    client.rpc("get_b2c_stripe_payment_contact_fallbacks"),
    client.rpc("get_b2c_stripe_payment_evidence"),
    client.from("integration_sync_runs").select("status,records_failed,completed_at").eq("provider", "stripe").eq("operation_type", "historical_backfill").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("integration_sync_runs").select("status,requested_range_end,completed_at").eq("provider", "stripe").eq("operation_type", "reconciliation").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("integration_sync_runs").select("status,records_failed,completed_at").eq("provider", "tap").eq("operation_type", "historical_backfill").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("integration_sync_runs").select("status,requested_range_end,completed_at").eq("provider", "tap").eq("operation_type", "reconciliation").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (paymentsResult.error ?? refundsResult.error ?? paymentFlagsResult.error ?? refundFlagsResult.error ?? localOverridesResult.error ?? financeExceptionResult.error ?? stripeContactFallbacksResult.error ?? stripeEvidenceResult.error ?? stripeHistoricalResult.error ?? stripeReconciliationResult.error ?? tapHistoricalResult.error ?? tapReconciliationResult.error) {
    throw new Error("Could not load B2C source records.");
  }

  const payments = paymentsResult.data ?? [];
  const refunds = refundsResult.data ?? [];
  const sourceCoverage = resolveB2cSourceCoverage({ providers: [
    { provider: "stripe", active: payments.some((payment) => payment.source_system === "stripe") || refunds.some((refund) => refund.source_system === "stripe") || Boolean(stripeHistoricalResult.data), historicalBackfill: stripeHistoricalResult.data ? { status: stripeHistoricalResult.data.status, recordsFailed: stripeHistoricalResult.data.records_failed, completedAt: stripeHistoricalResult.data.completed_at } : null, latestReconciliation: stripeReconciliationResult.data ? { status: stripeReconciliationResult.data.status, requestedRangeEnd: stripeReconciliationResult.data.requested_range_end, completedAt: stripeReconciliationResult.data.completed_at } : null },
    { provider: "tap", active: payments.some((payment) => payment.source_system === "tap") || refunds.some((refund) => refund.source_system === "tap") || Boolean(tapHistoricalResult.data), historicalBackfill: tapHistoricalResult.data ? { status: tapHistoricalResult.data.status, recordsFailed: tapHistoricalResult.data.records_failed, completedAt: tapHistoricalResult.data.completed_at } : null, latestReconciliation: tapReconciliationResult.data ? { status: tapReconciliationResult.data.status, requestedRangeEnd: tapReconciliationResult.data.requested_range_end, completedAt: tapReconciliationResult.data.completed_at } : null },
  ] });
  const overridesByPayment = new Map<string, LocalPaymentOverride>((localOverridesResult.data ?? []).map((override) => [override.payment_id, override]));
  const stripeFallbacksByPayment = new Map<string, B2cStripeContactFallback>((stripeContactFallbacksResult.data ?? []).map((fallback) => [fallback.payment_id, {
    customerName: fallback.customer_name, customerNameLabel: fallback.customer_name_label,
    customerEmail: fallback.customer_email, customerEmailLabel: fallback.customer_email_label,
    customerPhone: fallback.customer_phone, customerPhoneLabel: fallback.customer_phone_label,
  }]));
  const stripeEvidenceByPayment = new Map<string, B2cStripeEvidence>();
  for (const evidence of (stripeEvidenceResult.data ?? []) as StripeEvidenceProjection[]) {
    const current = stripeEvidenceByPayment.get(evidence.payment_id) ?? {
      originalAmount: evidence.original_amount,
      originalCurrency: evidence.original_currency,
      amountRefunded: evidence.charge_refunded_amount,
      description: evidence.charge_description,
      sellerMessage: evidence.seller_message,
      cardholderName: evidence.cardholder_name,
      settlementGrossAmount: evidence.settlement_gross_amount,
      settlementFeeAmount: evidence.settlement_fee_amount,
      settlementFeeTaxAmount: evidence.settlement_fee_tax_amount,
      settlementNetAmount: evidence.settlement_net_amount,
      settlementCurrency: evidence.settlement_currency,
      settlementExchangeRate: evidence.settlement_exchange_rate,
      refunds: [],
    };
    if (evidence.refund_id && evidence.refund_original_amount && evidence.refund_original_currency) {
      current.refunds.push({
        refundId: evidence.refund_id,
        originalAmount: evidence.refund_original_amount,
        originalCurrency: evidence.refund_original_currency,
        settlementRefundAmount: evidence.refund_settlement_amount,
        settlementCurrency: evidence.refund_settlement_currency,
        settlementExchangeRate: evidence.refund_settlement_exchange_rate,
      });
    }
    stripeEvidenceByPayment.set(evidence.payment_id, current);
  }
  const latestFinanceDecisionByPayment = new Map<string, FinanceExceptionDecision>();
  for (const decision of (financeExceptionResult.data ?? []) as FinanceExceptionDecision[]) {
    if (!latestFinanceDecisionByPayment.has(decision.payment_id)) latestFinanceDecisionByPayment.set(decision.payment_id, decision);
  }
  const flagsByRecord = new Map<string, Flag[]>();
  for (const flag of [...(paymentFlagsResult.data ?? []), ...(refundFlagsResult.data ?? [])]) {
    flagsByRecord.set(flag.source_record_id, [...(flagsByRecord.get(flag.source_record_id) ?? []), flag]);
  }
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const effectivePayment = (payment: typeof payments[number]) => {
    const override = overridesByPayment.get(payment.id);
    return resolveEffectiveB2cPayment({
      customerName: payment.customer_name,
      customerEmail: payment.customer_email,
      customerPhone: payment.customer_phone,
      categoryCode: payment.category_code,
      membershipTier: payment.membership_tier,
      amountUsd: payment.amount_usd,
      occurredOn: payment.occurred_on,
    }, override ? {
      customerName: override.customer_name,
      customerEmail: override.customer_email,
      customerPhone: override.customer_phone,
      categoryCode: override.category_code,
      membershipTier: override.membership_tier,
      amountUsd: override.local_amount_usd,
      occurredOn: override.local_occurred_on,
    } : null);
  };
  const paymentReportability = (payment: typeof payments[number]) => {
    const openFlags = flagsByRecord.get(payment.id) ?? [];
    const flagTypes = new Set(openFlags.map((flag) => flag.flag_type));
    const effective = effectivePayment(payment);
    const hasFinanceException = latestFinanceDecisionByPayment.get(payment.id)?.decision === "include";
    return {
      isReportable: isReportableB2cPayment({
        paymentStatus: payment.payment_status,
        customerEmail: effective.customerEmail,
        categoryCode: effective.categoryCode,
      openFlagTypes: flagTypes,
        originalCurrency: payment.original_currency,
        amountUsd: effective.amountUsd,
        hasFinanceException,
        hasBlockingNeedsFollowUp: openFlags.some((flag) => flag.flag_type === "needs_follow_up" && !isMissingCustomerEmailFlag(flag)),
      }),
      exclusions: b2cPaymentExclusionReasons({
        paymentStatus: payment.payment_status,
        customerEmail: effective.customerEmail,
        categoryCode: effective.categoryCode,
        openFlagTypes: flagTypes,
        originalCurrency: payment.original_currency,
        amountUsd: effective.amountUsd,
        hasFinanceException,
        hasBlockingNeedsFollowUp: openFlags.some((flag) => flag.flag_type === "needs_follow_up" && !isMissingCustomerEmailFlag(flag)),
      }),
    };
  };

  let eligiblePayments = BigInt(0);
  let refundsTotal = BigInt(0);
  let completedSourcePayments = BigInt(0);
  let sourceRefunds = BigInt(0);
  let excludedCompletedPayments = BigInt(0);
  let completedSourcePaymentCount = 0;
  let reportablePaymentCount = 0;
  let excludedCompletedPaymentCount = 0;
  let sourceRefundCount = 0;
  let eligibleRefundCount = 0;
  let missingCustomerEmailCount = 0;
  let unmappedProductCount = 0;
  let possibleDuplicateCount = 0;
  let otherReviewCount = 0;
  let nonSucceededPaymentCount = 0;
  let financeExceptionPaymentCount = 0;
  for (const payment of payments) {
    const effective = effectivePayment(payment);
    if (!isInB2cPeriod(effective.occurredOn, period)) continue;
    const reportability = paymentReportability(payment);
    if (payment.payment_status !== "succeeded") {
      nonSucceededPaymentCount += 1;
      continue;
    }
    completedSourcePaymentCount += 1;
    if (payment.amount_usd !== null) completedSourcePayments += toScaledUsd(payment.amount_usd);
    if (reportability.isReportable) {
      if (effective.amountUsd === null) throw new Error("A reportable B2C payment requires a USD amount.");
      const amount = toScaledUsd(effective.amountUsd);
      eligiblePayments += amount;
      reportablePaymentCount += 1;
      if (latestFinanceDecisionByPayment.get(payment.id)?.decision === "include") financeExceptionPaymentCount += 1;
      continue;
    }
    if (effective.amountUsd !== null) excludedCompletedPayments += toScaledUsd(effective.amountUsd);
    excludedCompletedPaymentCount += 1;
    if (reportability.exclusions.includes("missing_customer_email")) missingCustomerEmailCount += 1;
    if (reportability.exclusions.includes("unmapped_product")) unmappedProductCount += 1;
    if (reportability.exclusions.includes("possible_duplicate")) possibleDuplicateCount += 1;
    if (reportability.exclusions.includes("needs_follow_up") && !reportability.exclusions.includes("missing_customer_email")) otherReviewCount += 1;
  }
  for (const refund of refunds) {
    const occurredOn = refund.occurred_at.slice(0, 10);
    const payment = paymentById.get(refund.payment_id);
    if (!isInB2cPeriod(occurredOn, period)) continue;
    sourceRefundCount += 1;
    if (refund.amount_usd !== null) sourceRefunds += toScaledUsd(refund.amount_usd);
    if (payment && refund.amount_usd !== null && paymentReportability(payment).isReportable) {
      const amount = toScaledUsd(refund.amount_usd);
      refundsTotal += amount;
      eligibleRefundCount += 1;
    }
  }

  const rows: B2cLedgerRow[] = [
    ...payments.filter((payment) => isInB2cPeriod(effectivePayment(payment).occurredOn, period)).map((payment) => {
      const reviewFlags = (flagsByRecord.get(payment.id) ?? []).map((flag) => ({ id: flag.id, type: reviewFlagLabel(flag), reason: flag.reason }));
      const effective = effectivePayment(payment);
      const displayContact = resolveB2cContactDisplay(effective, stripeFallbacksByPayment.get(payment.id));
      return {
      id: payment.id,
      recordType: "Payment" as const,
      customerName: displayContact.customerName,
      customerEmail: displayContact.customerEmail,
      customerPhone: displayContact.customerPhone,
      customerNameEvidenceLabel: displayContact.customerNameLabel,
      customerEmailEvidenceLabel: displayContact.customerEmailLabel,
      customerPhoneEvidenceLabel: displayContact.customerPhoneLabel,
      date: formatDate(effective.occurredOn),
      dateValue: effective.occurredOn,
      amountUsd: effective.amountUsd === null
        ? formatSourceAmount(payment.original_amount, payment.original_currency)
        : formatUsd(toScaledUsd(effective.amountUsd)),
      amountValueUsd: effective.amountUsd,
      sourceAmountUsd: formatSourceAmount(payment.original_amount, payment.original_currency),
      sourceOriginalAmount: payment.original_amount,
      sourceOriginalCurrency: payment.original_currency,
      foreignCurrencyReview: payment.original_currency !== "USD",
      sourceDateValue: payment.occurred_on,
      category: !effective.categoryCode || effective.categoryCode === "unmapped" ? "Unmapped" : effective.categoryCode,
      membershipTier: effective.membershipTier,
      billingInterval: billingIntervalLabel(payment.source_metadata),
      source: payment.source_system === "manual_bank_transfer" ? "Manual bank transfer" : payment.source_system === "stripe" ? "Stripe" : "Tap",
      paymentStatus: displayPaymentStatus(payment.payment_status),
      providerReference: payment.provider_transaction_id,
      sourceSystem: payment.source_system,
      stripeEvidence: payment.source_system === "stripe" ? stripeEvidenceByPayment.get(payment.id) ?? {
        originalAmount: payment.original_amount,
        originalCurrency: payment.original_currency,
        amountRefunded: null,
        description: null, sellerMessage: null, cardholderName: null,
        settlementGrossAmount: null, settlementFeeAmount: null, settlementFeeTaxAmount: null, settlementNetAmount: null,
        settlementCurrency: null, settlementExchangeRate: null, refunds: [],
      } : null,
      productReference: sourceMetadataText(payment.source_metadata, "product_reference"),
      hasLocalCorrection: effective.hasLocalCorrection,
      localCorrectionFields: effective.correctedFields,
      hasFinanceException: latestFinanceDecisionByPayment.get(payment.id)?.decision === "include",
      openReviewFlags: reviewFlags,
      issue: flagLabel(flagsByRecord.get(payment.id) ?? []),
    };
    }),
    ...refunds.filter((refund) => {
      const occurredOn = refund.occurred_at.slice(0, 10);
      return isInB2cPeriod(occurredOn, period);
    }).map((refund) => {
      const payment = paymentById.get(refund.payment_id);
      const effective = payment ? effectivePayment(payment) : null;
      const displayContact = payment && effective ? resolveB2cContactDisplay(effective, stripeFallbacksByPayment.get(payment.id)) : null;
      const reviewFlags = (flagsByRecord.get(refund.id) ?? []).map((flag) => ({ id: flag.id, type: reviewFlagLabel(flag), reason: flag.reason }));
      return {
        id: refund.id,
        recordType: "Refund" as const,
        customerName: displayContact?.customerName ?? null,
        customerEmail: displayContact?.customerEmail ?? null,
        customerPhone: displayContact?.customerPhone ?? null,
        customerNameEvidenceLabel: displayContact?.customerNameLabel ?? null,
        customerEmailEvidenceLabel: displayContact?.customerEmailLabel ?? null,
        customerPhoneEvidenceLabel: displayContact?.customerPhoneLabel ?? null,
        date: formatDate(refund.occurred_at.slice(0, 10)),
        dateValue: refund.occurred_at.slice(0, 10),
        amountUsd: refund.amount_usd === null
          ? formatSourceAmount(refund.original_amount, refund.original_currency, true)
          : formatUsd(-toScaledUsd(refund.amount_usd)),
        amountValueUsd: refund.amount_usd === null ? null : `-${refund.amount_usd}`,
        sourceAmountUsd: formatSourceAmount(refund.original_amount, refund.original_currency, true),
        sourceOriginalAmount: refund.original_amount,
        sourceOriginalCurrency: refund.original_currency,
        foreignCurrencyReview: refund.original_currency !== "USD",
        sourceDateValue: refund.occurred_at.slice(0, 10),
        category: effective?.categoryCode === "unmapped" ? "Unmapped" : effective?.categoryCode ?? "Unavailable",
        membershipTier: effective?.membershipTier ?? null,
        billingInterval: null,
        source: refund.source_system === "stripe" ? "Stripe" : refund.source_system === "tap" ? "Tap" : "Manual bank transfer",
        paymentStatus: "Refunded" as const,
        providerReference: refund.provider_refund_id,
        sourceSystem: refund.source_system,
        productReference: null,
        hasLocalCorrection: Boolean(payment && effective?.hasLocalCorrection),
        localCorrectionFields: effective?.correctedFields ?? [],
        hasFinanceException: Boolean(payment && latestFinanceDecisionByPayment.get(payment.id)?.decision === "include"),
        openReviewFlags: reviewFlags,
        issue: flagLabel(flagsByRecord.get(refund.id) ?? []),
      };
    }),
  ].sort((first, second) => second.date.localeCompare(first.date));

  return {
    period,
    sourceCoverage,
    hasSourceRecords: payments.length > 0 || refunds.length > 0,
    eligiblePaymentsUsd: formatUsd(eligiblePayments),
    refundsUsd: formatUsd(refundsTotal),
    netPaymentsUsd: formatUsd(eligiblePayments - refundsTotal),
    completedSourcePaymentsUsd: formatUsd(completedSourcePayments),
    sourceRefundsUsd: formatUsd(sourceRefunds),
    calculation: {
      completedSourcePaymentCount,
      reportablePaymentCount,
      excludedCompletedPaymentCount,
      excludedCompletedPaymentsUsd: formatUsd(excludedCompletedPayments),
      sourceRefundCount,
      eligibleRefundCount,
      missingCustomerEmailCount,
      unmappedProductCount,
      possibleDuplicateCount,
      otherReviewCount,
      nonSucceededPaymentCount,
      financeExceptionPaymentCount,
    },
    reviewItems: [...flagsByRecord.values()].reduce((sum, flags) => sum + flags.length, 0),
    rows,
  };
}
