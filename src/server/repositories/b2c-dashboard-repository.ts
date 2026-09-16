import { z } from "zod";
import { parseB2cSqlPaymentDecision } from "@/lib/b2c/payment-reportability";
import { resolveB2cSourceCoverage, type B2cSourceCoverage } from "@/lib/b2c/source-coverage";
import { resolveEffectiveB2cPayment } from "@/lib/b2c/effective-payment";
import { retryTransient } from "@/lib/resilience";
import type { DatabaseClient } from "@/lib/supabase/server";

/**
 * Compatibility facade. `getB2cDashboardSnapshot` remains the one source
 * read for B2C period totals and ledger rows, and every existing consumer
 * keeps working unchanged. New focused reads build on top of it instead of
 * duplicating its source queries: `b2c-ledger-repository.ts` pages and
 * decorates its `rows` with the one accurate `B2cPaymentDecision`
 * (`src/lib/b2c/payment-decision.ts`), and `b2c-workspace-repository.ts`
 * aggregates those decorated rows into the Work queue's `B2cWorkItem`s
 * (`src/server/services/b2c-work-items.ts`).
 */

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
  /** Provider-supplied description retained from the local source record. */
  sourceDescription: string | null;
  /** A provider's own decline/status message (e.g. an issuing bank's decline reason). Read-only, never a local decision. */
  sourceSellerMessage?: string | null;
  /** True when the provider's original amount is not USD. */
  isForeignCurrency?: boolean;
  /** True only while a foreign source needs a Finance-approved local conversion. */
  foreignCurrencyReview?: boolean;
  hasFxConversion?: boolean;
  fxConversionSource?: string | null;
  fxConversionEffectiveOn?: string | null;
  sourceDateValue: string;
  membershipTier: string | null;
  billingInterval: string | null;
  source: string;
  paymentStatus: "Completed" | "Failed" | "Pending" | "Refunded";
  providerReference: string | null;
  sourceSystem: "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";
  productReference: string | null;
  hasLocalCorrection: boolean;
  localCorrectionFields: string[];
  hasFinanceException: boolean;
  /** Safe per-payment duplicate state; never exposes a group or another payment. */
  hasOpenPaymentDuplicate: boolean;
  /** Safe retained duplicate exclusion state; never exposes a group or another payment. */
  hasDuplicateExclusion: boolean;
  openReviewFlags: B2cOpenReviewFlag[];
  issue: "Possible duplicate" | "Failed" | "Missing customer email" | "Needs follow-up" | "Needs FX review" | "Refunded" | null;
  /** Safe, read-only Stripe evidence. It never participates in reportability. */
  stripeEvidence?: B2cStripeEvidence | null;
  /** Database-authoritative financial decision used only by the unpaginated Work queue. */
  sqlDecision?: unknown;
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

type PaymentDuplicateReportingState = {
  payment_id: string;
  has_open_duplicate: boolean;
  has_duplicate_exclusion: boolean;
};

type PaymentFxConversion = {
  id: string;
  payment_id: string;
  amount_usd: string;
  exchange_rate_to_usd: string;
  effective_on: string;
  conversion_source: string;
  created_at: string;
};

type RefundFxConversion = {
  id: string;
  refund_id: string;
  amount_usd: string;
  exchange_rate_to_usd: string;
  effective_on: string;
  conversion_source: string;
  created_at: string;
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
  type: Exclude<B2cLedgerRow["issue"], null>;
  reason: string;
};

function toScaledUsd(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Stored B2C USD value is invalid.");
  const scaled = BigInt(match[2]) * USD_SCALE + BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] === "-" ? -scaled : scaled;
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

/** Labels the retained source without suggesting a provider relationship that does not exist. */
export function resolveB2cLedgerSourceLabel(sourceSystem: B2cLedgerRow["sourceSystem"], sourceMetadata: unknown): string {
  if (sourceSystem === "stripe") return "Stripe";
  if (sourceSystem === "tap") return "Tap";
  if (sourceSystem === "manual_bank_transfer") return "Manual bank transfer";
  const financeMethod = sourceMetadataText(sourceMetadata, "finance_payment_method");
  if (financeMethod === "bank_transfer") return "Finance — Bank transfer";
  if (financeMethod === "ios") return "Finance — iOS";
  return "Finance";
}

/**
 * Exposes provider details already retained locally. Stripe's evidence
 * projection is richer when it exists; Tap uses its retained source metadata.
 */
export function resolveLedgerSourceDescription(
  sourceMetadata: unknown,
  stripeDescription: string | null | undefined,
): string | null {
  return stripeDescription?.trim() || sourceMetadataText(sourceMetadata, "description");
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

const nullableHistoricalCoverageSchema = z.object({
  status: z.string(),
  recordsFailed: z.number().int().nonnegative(),
  completedAt: z.string().nullable(),
}).strict().nullable();

const nullableReconciliationCoverageSchema = z.object({
  status: z.string(),
  requestedRangeEnd: z.string().nullable(),
  completedAt: z.string().nullable(),
}).strict().nullable();

const dashboardSummarySchema = z.object({
  has_source_records: z.boolean(),
  eligible_payments_usd: z.string(),
  refunds_usd: z.string(),
  net_payments_usd: z.string(),
  completed_source_payments_usd: z.string(),
  source_refunds_usd: z.string(),
  calculation: z.object({
    completed_source_payment_count: z.number().int().nonnegative(),
    reportable_payment_count: z.number().int().nonnegative(),
    excluded_completed_payment_count: z.number().int().nonnegative(),
    excluded_completed_payments_usd: z.string(),
    source_refund_count: z.number().int().nonnegative(),
    eligible_refund_count: z.number().int().nonnegative(),
    missing_customer_email_count: z.number().int().nonnegative(),
    possible_duplicate_count: z.number().int().nonnegative(),
    other_review_count: z.number().int().nonnegative(),
    non_succeeded_payment_count: z.number().int().nonnegative(),
    finance_exception_payment_count: z.number().int().nonnegative(),
  }).strict(),
  review_items: z.number().int().nonnegative(),
  source_coverage_inputs: z.object({
    providers: z.array(z.object({
      provider: z.enum(["stripe", "tap"]),
      active: z.boolean(),
      historicalBackfill: nullableHistoricalCoverageSchema,
      latestReconciliation: nullableReconciliationCoverageSchema,
    }).strict()),
  }).strict(),
}).strict();

const ledgerDecisionsSchema = z.array(z.object({
  record_type: z.enum(["Payment", "Refund"]),
  record_id: z.string().uuid(),
  decision: z.unknown(),
}).strict());

/** Loads only the database aggregate needed by the page header. */
export async function getB2cDashboardSummary(
  client: DatabaseClient,
  today = new Date(),
  selectedMonth?: string,
): Promise<B2cDashboardSnapshot> {
  const period = resolveB2cReportingPeriod(selectedMonth, today);
  const { data, error } = await client.rpc("get_b2c_dashboard_summary", {
    p_period: period.month,
    p_today: today.toISOString().slice(0, 10),
  });
  if (error) throw new Error("Could not load the B2C dashboard summary.");
  const parsed = dashboardSummarySchema.safeParse(data);
  if (!parsed.success) throw new Error("Invalid B2C dashboard summary returned by the database.");
  const summary = parsed.data;

  return {
    period,
    sourceCoverage: resolveB2cSourceCoverage(summary.source_coverage_inputs),
    hasSourceRecords: summary.has_source_records,
    eligiblePaymentsUsd: formatUsd(toScaledUsd(summary.eligible_payments_usd)),
    refundsUsd: formatUsd(toScaledUsd(summary.refunds_usd)),
    netPaymentsUsd: formatUsd(toScaledUsd(summary.net_payments_usd)),
    completedSourcePaymentsUsd: formatUsd(toScaledUsd(summary.completed_source_payments_usd)),
    sourceRefundsUsd: formatUsd(toScaledUsd(summary.source_refunds_usd)),
    calculation: {
      completedSourcePaymentCount: summary.calculation.completed_source_payment_count,
      reportablePaymentCount: summary.calculation.reportable_payment_count,
      excludedCompletedPaymentCount: summary.calculation.excluded_completed_payment_count,
      excludedCompletedPaymentsUsd: formatUsd(toScaledUsd(summary.calculation.excluded_completed_payments_usd)),
      sourceRefundCount: summary.calculation.source_refund_count,
      eligibleRefundCount: summary.calculation.eligible_refund_count,
      missingCustomerEmailCount: summary.calculation.missing_customer_email_count,
      possibleDuplicateCount: summary.calculation.possible_duplicate_count,
      otherReviewCount: summary.calculation.other_review_count,
      nonSucceededPaymentCount: summary.calculation.non_succeeded_payment_count,
      financeExceptionPaymentCount: summary.calculation.finance_exception_payment_count,
    },
    reviewItems: summary.review_items,
    rows: [],
  };
}

function isInB2cPeriod(date: string, period: B2cReportingPeriod): boolean {
  return period.isAllTime || (date >= period.monthStart && date <= period.monthEnd);
}

/** Legacy all-record read retained only for the unpaginated Work queue and the local equivalence oracle. */
function loadB2cSnapshotResults(client: DatabaseClient, today: Date) {
  return Promise.all([
    client.from("b2c_payments").select("id,source_system,provider_transaction_id,customer_name,customer_email,customer_phone,membership_tier,payment_status,original_amount,original_currency,amount_usd,occurred_on,source_metadata").order("occurred_at", { ascending: false }),
    client.from("b2c_refunds").select("id,payment_id,source_system,provider_refund_id,original_amount,original_currency,amount_usd,occurred_at").order("occurred_at", { ascending: false }),
    client.from("review_flags").select("id,source_area,source_record_id,flag_type,reason").eq("source_area", "b2c_payment").eq("status", "open"),
    client.from("review_flags").select("id,source_area,source_record_id,flag_type,reason").eq("source_area", "b2c_refund").eq("status", "open"),
    client.from("b2c_payment_local_overrides").select("payment_id,customer_name,customer_email,customer_phone,membership_tier,local_amount_usd,local_occurred_on"),
    client.from("b2c_payment_fx_conversions").select("id,payment_id,amount_usd,exchange_rate_to_usd,effective_on,conversion_source,created_at").order("created_at", { ascending: false }),
    client.from("b2c_refund_fx_conversions").select("id,refund_id,amount_usd,exchange_rate_to_usd,effective_on,conversion_source,created_at").order("created_at", { ascending: false }),
    client.from("b2c_payment_finance_exception_decisions").select("id,payment_id,decision,created_at").order("created_at", { ascending: false }),
    client.rpc("get_b2c_payment_duplicate_reporting_states"),
    client.rpc("get_b2c_stripe_payment_contact_fallbacks"),
    client.rpc("get_b2c_stripe_payment_evidence"),
    client.from("integration_sync_runs").select("status,records_failed,completed_at").eq("provider", "stripe").eq("operation_type", "historical_backfill").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("integration_sync_runs").select("status,requested_range_end,completed_at").eq("provider", "stripe").eq("operation_type", "reconciliation").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("integration_sync_runs").select("status,records_failed,completed_at").eq("provider", "tap").eq("operation_type", "historical_backfill").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("integration_sync_runs").select("status,requested_range_end,completed_at").eq("provider", "tap").eq("operation_type", "reconciliation").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.rpc("get_b2c_ledger_decisions", { p_today: today.toISOString().slice(0, 10) }),
  ]);
}

function hasSnapshotError(results: Awaited<ReturnType<typeof loadB2cSnapshotResults>>): boolean {
  return results.some((result) => result.error);
}

export async function getB2cDashboardSnapshot(client: DatabaseClient, today = new Date(), selectedMonth?: string): Promise<B2cDashboardSnapshot> {
  const period = resolveB2cReportingPeriod(selectedMonth, today);
  // 16 independent queries run concurrently, so a single dropped connection
  // on any one of them previously failed the entire dashboard. Retrying the
  // whole batch absorbs a run of flaky round trips before giving up for real.
  const results = await retryTransient(() => loadB2cSnapshotResults(client, today), hasSnapshotError);
  const [paymentsResult, refundsResult, paymentFlagsResult, refundFlagsResult, localOverridesResult, paymentFxConversionsResult, refundFxConversionsResult, financeExceptionResult, duplicateReportingStatesResult, stripeContactFallbacksResult, stripeEvidenceResult, stripeHistoricalResult, stripeReconciliationResult, tapHistoricalResult, tapReconciliationResult, decisionsResult] = results;
  if (hasSnapshotError(results)) {
    throw new Error("Could not load B2C source records.");
  }

  const payments = paymentsResult.data ?? [];
  const refunds = refundsResult.data ?? [];
  const decisionsByRecord = new Map<string, unknown>();
  for (const result of ledgerDecisionsSchema.parse(decisionsResult.data)) {
    parseB2cSqlPaymentDecision(result.decision);
    decisionsByRecord.set(`${result.record_type}:${result.record_id}`, result.decision);
    // Parsing here is intentional: a malformed database decision must fail
    // the whole financial read rather than falling back to application logic.
  }
  const openDuplicatePaymentIds = new Set<string>();
  const excludedDuplicatePaymentIds = new Set<string>();
  for (const state of (duplicateReportingStatesResult.data ?? []) as PaymentDuplicateReportingState[]) {
    if (state.has_open_duplicate) openDuplicatePaymentIds.add(state.payment_id);
    if (state.has_duplicate_exclusion) excludedDuplicatePaymentIds.add(state.payment_id);
  }
  const sourceCoverage = resolveB2cSourceCoverage({ providers: [
    { provider: "stripe", active: payments.some((payment) => payment.source_system === "stripe") || refunds.some((refund) => refund.source_system === "stripe") || Boolean(stripeHistoricalResult.data), historicalBackfill: stripeHistoricalResult.data ? { status: stripeHistoricalResult.data.status, recordsFailed: stripeHistoricalResult.data.records_failed, completedAt: stripeHistoricalResult.data.completed_at } : null, latestReconciliation: stripeReconciliationResult.data ? { status: stripeReconciliationResult.data.status, requestedRangeEnd: stripeReconciliationResult.data.requested_range_end, completedAt: stripeReconciliationResult.data.completed_at } : null },
    { provider: "tap", active: payments.some((payment) => payment.source_system === "tap") || refunds.some((refund) => refund.source_system === "tap") || Boolean(tapHistoricalResult.data), historicalBackfill: tapHistoricalResult.data ? { status: tapHistoricalResult.data.status, recordsFailed: tapHistoricalResult.data.records_failed, completedAt: tapHistoricalResult.data.completed_at } : null, latestReconciliation: tapReconciliationResult.data ? { status: tapReconciliationResult.data.status, requestedRangeEnd: tapReconciliationResult.data.requested_range_end, completedAt: tapReconciliationResult.data.completed_at } : null },
  ] });
  const overridesByPayment = new Map<string, LocalPaymentOverride>((localOverridesResult.data ?? []).map((override) => [override.payment_id, override]));
  const latestPaymentFxConversionByPayment = new Map<string, PaymentFxConversion>();
  for (const conversion of (paymentFxConversionsResult.data ?? []) as PaymentFxConversion[]) {
    if (!latestPaymentFxConversionByPayment.has(conversion.payment_id)) latestPaymentFxConversionByPayment.set(conversion.payment_id, conversion);
  }
  const latestRefundFxConversionByRefund = new Map<string, RefundFxConversion>();
  for (const conversion of (refundFxConversionsResult.data ?? []) as RefundFxConversion[]) {
    if (!latestRefundFxConversionByRefund.has(conversion.refund_id)) latestRefundFxConversionByRefund.set(conversion.refund_id, conversion);
  }
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
  const liveFlags = [...(paymentFlagsResult.data ?? []), ...(refundFlagsResult.data ?? [])]
    .filter((flag) => flag.flag_type !== "unmapped_product");
  const flagsByRecord = new Map<string, Flag[]>();
  for (const flag of liveFlags) {
    flagsByRecord.set(flag.source_record_id, [...(flagsByRecord.get(flag.source_record_id) ?? []), flag]);
  }
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const effectivePayment = (payment: typeof payments[number]) => {
    const override = overridesByPayment.get(payment.id);
    const conversion = latestPaymentFxConversionByPayment.get(payment.id);
    return resolveEffectiveB2cPayment({
      customerName: payment.customer_name,
      customerEmail: payment.customer_email,
      customerPhone: payment.customer_phone,
      membershipTier: payment.membership_tier,
      amountUsd: payment.amount_usd,
      originalCurrency: payment.original_currency,
      occurredOn: payment.occurred_on,
    }, override ? {
      customerName: override.customer_name,
      customerEmail: override.customer_email,
      customerPhone: override.customer_phone,
      membershipTier: override.membership_tier,
      // A provider's foreign-currency amount can never be bypassed with the
      // generic local-USD overlay. Only the append-only Finance conversion
      // may supply USD for that source.
      amountUsd: payment.original_currency === "USD" ? override.local_amount_usd : null,
      occurredOn: override.local_occurred_on,
    } : null, conversion ? { amountUsd: conversion.amount_usd } : null);
  };
  const paymentReportability = (payment: typeof payments[number]) => {
    const rawDecision = decisionsByRecord.get(`Payment:${payment.id}`);
    if (!rawDecision) throw new Error("A B2C payment is missing its database decision.");
    const decision = parseB2cSqlPaymentDecision(rawDecision);
    return {
      isReportable: decision.reportingDecision === "reportable" || decision.reportingDecision === "exception_included",
      exclusions: decision.exclusionReasons,
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
    // This card is intentionally source USD only. Foreign provider amounts
    // do not become a USD source total merely because they were retained.
    if (payment.original_currency === "USD" && payment.amount_usd !== null) completedSourcePayments += toScaledUsd(payment.amount_usd);
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
    if (reportability.exclusions.includes("possible_duplicate")) possibleDuplicateCount += 1;
    if (reportability.exclusions.includes("needs_follow_up") && !reportability.exclusions.includes("missing_customer_email")) otherReviewCount += 1;
  }
  for (const refund of refunds) {
    const occurredOn = refund.occurred_at.slice(0, 10);
    const payment = paymentById.get(refund.payment_id);
    if (!isInB2cPeriod(occurredOn, period)) continue;
    sourceRefundCount += 1;
    const convertedRefund = latestRefundFxConversionByRefund.get(refund.id);
    const effectiveRefundAmountUsd = refund.original_currency === "USD" ? refund.amount_usd : convertedRefund?.amount_usd ?? null;
    if (refund.original_currency === "USD" && refund.amount_usd !== null) sourceRefunds += toScaledUsd(refund.amount_usd);
    if (payment && effectiveRefundAmountUsd !== null && paymentReportability(payment).isReportable) {
      const amount = toScaledUsd(effectiveRefundAmountUsd);
      refundsTotal += amount;
      eligibleRefundCount += 1;
    }
  }

  const rows: B2cLedgerRow[] = [
    ...payments.filter((payment) => isInB2cPeriod(effectivePayment(payment).occurredOn, period)).map((payment) => {
      const effective = effectivePayment(payment);
      const conversion = latestPaymentFxConversionByPayment.get(payment.id);
      const displayContact = resolveB2cContactDisplay(effective, stripeFallbacksByPayment.get(payment.id));
      // Preserve the existing display behavior for a stale missing-email flag.
      // This affects only the badge: labelled Stripe fallback context never
      // satisfies the database-authoritative reportability decision.
      const paymentFlags = (flagsByRecord.get(payment.id) ?? []).filter((flag) => !isMissingCustomerEmailFlag(flag) || !displayContact.customerEmail);
      const reviewFlags = paymentFlags.map((flag) => ({ id: flag.id, type: reviewFlagLabel(flag), reason: flag.reason }));
      const stripeEvidence = payment.source_system === "stripe" ? stripeEvidenceByPayment.get(payment.id) ?? {
        originalAmount: payment.original_amount,
        originalCurrency: payment.original_currency,
        amountRefunded: null,
        description: null, sellerMessage: null, cardholderName: null,
        settlementGrossAmount: null, settlementFeeAmount: null, settlementFeeTaxAmount: null, settlementNetAmount: null,
        settlementCurrency: null, settlementExchangeRate: null, refunds: [],
      } : null;
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
      sourceDescription: resolveLedgerSourceDescription(payment.source_metadata, stripeEvidence?.description),
      sourceSellerMessage: stripeEvidence?.sellerMessage ?? null,
      isForeignCurrency: payment.original_currency !== "USD",
      foreignCurrencyReview: payment.original_currency !== "USD" && effective.amountUsd === null,
      hasFxConversion: Boolean(conversion),
      fxConversionSource: conversion?.conversion_source ?? null,
      fxConversionEffectiveOn: conversion?.effective_on ?? null,
      sourceDateValue: payment.occurred_on,
      membershipTier: effective.membershipTier,
      billingInterval: billingIntervalLabel(payment.source_metadata),
      source: resolveB2cLedgerSourceLabel(payment.source_system, payment.source_metadata),
      paymentStatus: displayPaymentStatus(payment.payment_status),
      providerReference: payment.provider_transaction_id,
      sourceSystem: payment.source_system,
      stripeEvidence,
      sqlDecision: decisionsByRecord.get(`Payment:${payment.id}`),
      productReference: sourceMetadataText(payment.source_metadata, "product_reference"),
      hasLocalCorrection: effective.hasLocalCorrection,
      localCorrectionFields: effective.correctedFields,
      hasFinanceException: latestFinanceDecisionByPayment.get(payment.id)?.decision === "include",
      hasOpenPaymentDuplicate: openDuplicatePaymentIds.has(payment.id),
      hasDuplicateExclusion: excludedDuplicatePaymentIds.has(payment.id),
      openReviewFlags: reviewFlags,
      issue: flagLabel(paymentFlags),
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
      const conversion = latestRefundFxConversionByRefund.get(refund.id);
      const effectiveRefundAmountUsd = refund.original_currency === "USD" ? refund.amount_usd : conversion?.amount_usd ?? null;
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
        amountUsd: effectiveRefundAmountUsd === null
          ? formatSourceAmount(refund.original_amount, refund.original_currency, true)
          : formatUsd(-toScaledUsd(effectiveRefundAmountUsd)),
        amountValueUsd: effectiveRefundAmountUsd === null ? null : `-${effectiveRefundAmountUsd}`,
        sourceAmountUsd: formatSourceAmount(refund.original_amount, refund.original_currency, true),
        sourceOriginalAmount: refund.original_amount,
        sourceOriginalCurrency: refund.original_currency,
        sourceDescription: null,
        isForeignCurrency: refund.original_currency !== "USD",
        foreignCurrencyReview: refund.original_currency !== "USD" && effectiveRefundAmountUsd === null,
        hasFxConversion: Boolean(conversion),
        fxConversionSource: conversion?.conversion_source ?? null,
        fxConversionEffectiveOn: conversion?.effective_on ?? null,
        sourceDateValue: refund.occurred_at.slice(0, 10),
        membershipTier: effective?.membershipTier ?? null,
        billingInterval: null,
        source: refund.source_system === "stripe" ? "Stripe" : refund.source_system === "tap" ? "Tap" : "Manual bank transfer",
        paymentStatus: "Refunded" as const,
        providerReference: refund.provider_refund_id,
        sourceSystem: refund.source_system,
        productReference: null,
        sqlDecision: decisionsByRecord.get(`Refund:${refund.id}`),
        hasLocalCorrection: Boolean(payment && effective?.hasLocalCorrection),
        localCorrectionFields: effective?.correctedFields ?? [],
        hasFinanceException: Boolean(payment && latestFinanceDecisionByPayment.get(payment.id)?.decision === "include"),
        hasOpenPaymentDuplicate: Boolean(payment && openDuplicatePaymentIds.has(payment.id)),
        hasDuplicateExclusion: Boolean(payment && excludedDuplicatePaymentIds.has(payment.id)),
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
      possibleDuplicateCount,
      otherReviewCount,
      nonSucceededPaymentCount,
      financeExceptionPaymentCount,
    },
    reviewItems: liveFlags.length,
    rows,
  };
}
