import { z } from "zod";
import { presentB2cPaymentDecision, type B2cPaymentDecision } from "@/lib/b2c/payment-decision";
import { resolveB2cReportingPeriod, type B2cLedgerRow } from "@/server/repositories/b2c-dashboard-repository";
import type { DatabaseClient } from "@/lib/supabase/server";

export const B2C_LEDGER_MAX_LIMIT = 100;
export const B2C_LEDGER_DEFAULT_LIMIT = 25;

export type B2cLedgerSort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

export type B2cLedgerQuery = {
  cursor?: string;
  limit?: number;
  period?: string;
  source?: B2cLedgerRow["sourceSystem"];
  sourceStatus?: "succeeded" | "failed" | "pending";
  paymentStatus?: B2cLedgerRow["paymentStatus"];
  reportingDecision?: B2cPaymentDecision["reportingDecision"];
  issue?: NonNullable<B2cLedgerRow["issue"]> | "none";
  dateFrom?: string;
  dateTo?: string;
  foreignCurrencyOnly?: boolean;
  currency?: string;
  minAmountUsd?: string;
  maxAmountUsd?: string;
  sort?: B2cLedgerSort;
  search?: string;
};

export type B2cDecoratedLedgerRow = Omit<B2cLedgerRow, "sqlDecision"> & {
  decision: B2cPaymentDecision;
};

export type B2cLedgerFilterMetadata = {
  sources: string[];
  issues: NonNullable<B2cLedgerRow["issue"]>[];
  foreignCurrencyCount: number;
};

export type B2cLedgerPage = {
  rows: B2cDecoratedLedgerRow[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  filterMetadata: B2cLedgerFilterMetadata;
};

export type B2cLedgerCursor = {
  version: 1;
  sort: B2cLedgerSort;
  value: string;
  recordType: "Payment" | "Refund";
  id: string;
};

const cursorSchema = z.object({
  version: z.literal(1),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]),
  value: z.string().min(1).max(100),
  recordType: z.enum(["Payment", "Refund"]),
  id: z.string().uuid(),
}).strict();

export class B2cLedgerCursorError extends Error {
  constructor(message = "The B2C Ledger page cursor is invalid.") {
    super(message);
    this.name = "B2cLedgerCursorError";
  }
}

export function encodeB2cLedgerCursor(cursor: B2cLedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeB2cLedgerCursor(value: string, expectedSort: B2cLedgerSort): B2cLedgerCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const cursor = cursorSchema.parse(decoded);
    if (cursor.sort !== expectedSort) {
      throw new B2cLedgerCursorError("The B2C Ledger cursor does not match the selected sort.");
    }
    return cursor;
  } catch (error) {
    if (error instanceof B2cLedgerCursorError) throw error;
    throw new B2cLedgerCursorError();
  }
}

const issueSchema = z.enum([
  "Possible duplicate",
  "Failed",
  "Missing customer email",
  "Needs follow-up",
  "Needs FX review",
  "Refunded",
]);

const openReviewFlagSchema = z.object({
  id: z.string().uuid(),
  type: issueSchema,
  reason: z.string(),
}).strict();

const correctionFieldSchema = z.enum([
  "customerName",
  "customerEmail",
  "customerPhone",
  "membershipTier",
  "amountUsd",
  "occurredOn",
]);

const rowDataSchema = z.object({
  id: z.string().uuid(),
  record_type: z.enum(["Payment", "Refund"]),
  customer_name: z.string().nullable(),
  customer_email: z.string().nullable(),
  customer_phone: z.string().nullable(),
  customer_name_evidence_label: z.enum(["Stripe payment method", "Stripe profile"]).nullable(),
  customer_email_evidence_label: z.enum(["Stripe payment method", "Stripe profile"]).nullable(),
  customer_phone_evidence_label: z.enum(["Stripe payment method", "Stripe profile"]).nullable(),
  date_value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_value_usd: z.string().nullable(),
  source_original_amount: z.string(),
  source_original_currency: z.string().length(3),
  source_description: z.string().nullable(),
  source_seller_message: z.string().nullable(),
  foreign_currency_review: z.boolean(),
  has_fx_conversion: z.boolean(),
  fx_conversion_source: z.string().nullable(),
  fx_conversion_effective_on: z.string().nullable(),
  source_date_value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  membership_tier: z.string().nullable(),
  source: z.string(),
  payment_status: z.enum(["Completed", "Failed", "Pending", "Refunded"]),
  provider_reference: z.string().nullable(),
  source_system: z.enum(["stripe", "tap", "manual_bank_transfer", "finance_tracker"]),
  product_reference: z.string().nullable(),
  source_metadata: z.record(z.string(), z.unknown()),
  has_local_correction: z.boolean(),
  local_correction_fields: z.array(correctionFieldSchema),
  has_finance_exception: z.boolean(),
  has_open_payment_duplicate: z.boolean(),
  has_duplicate_exclusion: z.boolean(),
  open_review_flags: z.array(openReviewFlagSchema),
  issue: issueSchema.nullable(),
}).strict();

const pageIdentitySchema = z.object({
  record_type: z.enum(["Payment", "Refund"]),
  record_id: z.string().uuid(),
  sort_value: z.string(),
  decision: z.unknown(),
}).strict();

const hydrationSchema = z.object({
  record_type: z.enum(["Payment", "Refund"]),
  record_id: z.string().uuid(),
  row_data: rowDataSchema,
  decision: z.unknown(),
}).strict();

const metadataSchema = z.object({
  total_count: z.number().int().nonnegative(),
  sources: z.array(z.string()),
  issues: z.array(issueSchema),
  foreign_currency_count: z.number().int().nonnegative(),
}).strict();

const USD_SCALE = BigInt(1_000_000);

function scaledUsd(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("The B2C Ledger returned an invalid USD value.");
  const scaled = BigInt(match[2]) * USD_SCALE + BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] === "-" ? -scaled : scaled;
}

function formatUsd(value: string): string {
  const scaled = scaledUsd(value);
  const absolute = scaled < BigInt(0) ? -scaled : scaled;
  const whole = absolute / USD_SCALE;
  const cents = (absolute % USD_SCALE) / BigInt(10_000);
  return `${scaled < BigInt(0) ? "−" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

function formatSourceAmount(value: string, currency: string, negative: boolean): string {
  if (currency === "USD") return formatUsd(`${negative ? "-" : ""}${value}`);
  const compact = value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return `${negative ? "−" : ""}${compact} ${currency}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
}

function billingIntervalLabel(metadata: Record<string, unknown>): string | null {
  const interval = typeof metadata.stripe_billing_interval === "string" ? metadata.stripe_billing_interval : null;
  const rawCount = typeof metadata.stripe_billing_interval_count === "string" ? metadata.stripe_billing_interval_count : "1";
  const count = Number(rawCount);
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

function mapHydratedRow(value: z.infer<typeof hydrationSchema>): B2cDecoratedLedgerRow {
  const raw = value.row_data;
  const negative = raw.record_type === "Refund";
  const sourceAmount = formatSourceAmount(raw.source_original_amount, raw.source_original_currency, negative);
  return {
    id: raw.id,
    recordType: raw.record_type,
    customerName: raw.customer_name,
    customerEmail: raw.customer_email,
    customerPhone: raw.customer_phone,
    customerNameEvidenceLabel: raw.customer_name_evidence_label,
    customerEmailEvidenceLabel: raw.customer_email_evidence_label,
    customerPhoneEvidenceLabel: raw.customer_phone_evidence_label,
    date: formatDate(raw.date_value),
    dateValue: raw.date_value,
    amountUsd: raw.amount_value_usd === null ? sourceAmount : formatUsd(raw.amount_value_usd),
    amountValueUsd: raw.amount_value_usd,
    sourceAmountUsd: sourceAmount,
    sourceOriginalAmount: raw.source_original_amount,
    sourceOriginalCurrency: raw.source_original_currency,
    sourceDescription: raw.source_description,
    sourceSellerMessage: raw.source_seller_message,
    isForeignCurrency: raw.source_original_currency !== "USD",
    foreignCurrencyReview: raw.foreign_currency_review,
    hasFxConversion: raw.has_fx_conversion,
    fxConversionSource: raw.fx_conversion_source,
    fxConversionEffectiveOn: raw.fx_conversion_effective_on,
    sourceDateValue: raw.source_date_value,
    membershipTier: raw.membership_tier,
    billingInterval: raw.record_type === "Payment" ? billingIntervalLabel(raw.source_metadata) : null,
    source: raw.source,
    paymentStatus: raw.payment_status,
    providerReference: raw.provider_reference,
    sourceSystem: raw.source_system,
    productReference: raw.product_reference,
    hasLocalCorrection: raw.has_local_correction,
    localCorrectionFields: raw.local_correction_fields,
    hasFinanceException: raw.has_finance_exception,
    hasOpenPaymentDuplicate: raw.has_open_payment_duplicate,
    hasDuplicateExclusion: raw.has_duplicate_exclusion,
    openReviewFlags: raw.open_review_flags,
    issue: raw.issue,
    decision: presentB2cPaymentDecision(value.decision),
  };
}

/** Presents the database decision attached to a legacy Work-queue row. */
export function decorateB2cLedgerRow(row: B2cLedgerRow): B2cDecoratedLedgerRow {
  const { sqlDecision, ...ledgerRow } = row;
  return {
    ...ledgerRow,
    decision: presentB2cPaymentDecision(sqlDecision),
  };
}

function rpcFilters(query: B2cLedgerQuery, period: string, today: string) {
  return {
    p_period: period,
    p_today: today,
    p_source: query.source ?? null,
    p_source_status: query.sourceStatus ?? null,
    p_payment_status: query.paymentStatus ?? null,
    p_reporting_decision: query.reportingDecision ?? null,
    p_issue: query.issue ?? null,
    p_date_from: query.dateFrom ?? null,
    p_date_to: query.dateTo ?? null,
    p_foreign_currency_only: query.foreignCurrencyOnly ?? false,
    p_currency: query.currency ?? null,
    p_min_amount_usd: query.minAmountUsd ?? null,
    p_max_amount_usd: query.maxAmountUsd ?? null,
    p_search: query.search ?? null,
  };
}

export class SupabaseB2cLedgerRepository {
  constructor(private readonly client: DatabaseClient) {}

  async page(query: B2cLedgerQuery, today = new Date()): Promise<B2cLedgerPage> {
    const sort = query.sort ?? "date_desc";
    const limit = Math.min(Math.max(query.limit ?? B2C_LEDGER_DEFAULT_LIMIT, 1), B2C_LEDGER_MAX_LIMIT);
    const period = resolveB2cReportingPeriod(query.period, today).month;
    const todayValue = today.toISOString().slice(0, 10);
    const cursor = query.cursor ? decodeB2cLedgerCursor(query.cursor, sort) : null;
    const filters = rpcFilters(query, period, todayValue);

    const [pageResult, metadataResult] = await Promise.all([
      this.client.rpc("get_b2c_ledger_page", {
        ...filters,
        p_limit: limit + 1,
        p_sort: sort,
        p_after_value: cursor?.value ?? null,
        p_after_record_type: cursor?.recordType ?? null,
        p_after_id: cursor?.id ?? null,
      }),
      this.client.rpc("get_b2c_ledger_metadata", filters),
    ]);
    if (pageResult.error || metadataResult.error) {
      throw new Error("Could not load the B2C Ledger page.");
    }

    const identities = z.array(pageIdentitySchema).parse(pageResult.data ?? []);
    const metadata = metadataSchema.parse(metadataResult.data);
    const hasMore = identities.length > limit;
    const selected = identities.slice(0, limit);

    if (selected.length === 0) {
      return {
        rows: [],
        nextCursor: null,
        hasMore: false,
        totalCount: metadata.total_count,
        filterMetadata: {
          sources: metadata.sources,
          issues: metadata.issues,
          foreignCurrencyCount: metadata.foreign_currency_count,
        },
      };
    }

    const paymentIds = selected.filter((row) => row.record_type === "Payment").map((row) => row.record_id);
    const refundIds = selected.filter((row) => row.record_type === "Refund").map((row) => row.record_id);
    const hydrationResult = await this.client.rpc("get_b2c_ledger_rows", {
      p_payment_ids: paymentIds,
      p_refund_ids: refundIds,
      p_today: todayValue,
    });
    if (hydrationResult.error) throw new Error("Could not hydrate the B2C Ledger page.");

    const hydrated = z.array(hydrationSchema).parse(hydrationResult.data ?? []);
    const hydratedByKey = new Map(hydrated.map((row) => [`${row.record_type}:${row.record_id}`, mapHydratedRow(row)]));
    const rows = selected.map((identity) => {
      const row = hydratedByKey.get(`${identity.record_type}:${identity.record_id}`);
      if (!row) throw new Error("The B2C Ledger page hydration was incomplete.");
      return row;
    });
    const last = selected.at(-1)!;

    return {
      rows,
      nextCursor: hasMore ? encodeB2cLedgerCursor({
        version: 1,
        sort,
        value: last.sort_value,
        recordType: last.record_type,
        id: last.record_id,
      }) : null,
      hasMore,
      totalCount: metadata.total_count,
      filterMetadata: {
        sources: metadata.sources,
        issues: metadata.issues,
        foreignCurrencyCount: metadata.foreign_currency_count,
      },
    };
  }
}
