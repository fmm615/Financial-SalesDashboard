import { z } from "zod";
import type { NormalisedB2cProviderCharge, NormalisedB2cProviderRefund } from "@/server/repositories/stripe-sync-repository";

const metadataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});
const timestampSchema = z.union([z.string(), z.number()]).nullable().optional();
const amountSchema = z.union([z.number().positive(), z.string().regex(/^\d+(?:\.\d{1,6})?$/)]);

const customerSchema = z.object({
  first_name: z.string().nullable().optional(),
  middle_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.object({ country_code: z.union([z.string(), z.number()]).nullable().optional(), number: z.union([z.string(), z.number()]).nullable().optional() }).nullable().optional(),
}).nullable().optional();

const referenceSchema = z.object({
  gateway: z.string().nullable().optional(),
  payment: z.union([z.string(), z.number()]).nullable().optional(),
}).nullable().optional();

const tapChargeSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: amountSchema,
  currency: z.string().length(3),
  product: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  customer: customerSchema,
  metadata: metadataSchema.optional(),
  transaction: z.object({ created: timestampSchema }).nullable().optional(),
  created: timestampSchema,
  reference: referenceSchema,
}).passthrough();

const tapRefundSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: amountSchema,
  currency: z.string().length(3),
  charge: z.union([z.string(), z.object({ id: z.string().min(1) }).passthrough()]).nullable().optional(),
  transaction: z.object({ created: timestampSchema }).nullable().optional(),
  created: timestampSchema,
  reference: referenceSchema,
  description: z.string().nullable().optional(),
  metadata: metadataSchema.optional(),
}).passthrough();

export class TapNormalisationError extends Error {}
/** A non-completed Tap refund is not yet a financial refund. */
export class TapRefundNotSucceededError extends TapNormalisationError {}

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function validatedEmail(value: string | null | undefined): string | null {
  const email = cleanText(value, 320)?.toLowerCase();
  return email && z.string().email().safeParse(email).success ? email : null;
}

function tapDecimal(value: string | number): string {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) throw new TapNormalisationError("Tap returned an invalid payment amount.");
  // Tap returns major currency units. Convert only to a canonical decimal
  // string; JavaScript floating point is never used for arithmetic here.
  const formatted = numberValue.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(formatted)) throw new TapNormalisationError("Tap returned an invalid payment amount.");
  return formatted;
}

function bahrainBusinessDate(occurredAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bahrain", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(occurredAt);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timestampToDate(value: string | number | null | undefined): Date {
  const numericValue = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const timestamp = Number.isFinite(numericValue) ? (numericValue > 10_000_000_000 ? numericValue : numericValue * 1000) : Date.parse(typeof value === "string" ? value : "");
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new TapNormalisationError("Tap returned an invalid payment timestamp.");
  return date;
}

function requireUsd(currency: string): "USD" {
  if (currency !== "USD") throw new TapNormalisationError(`Tap charge uses ${currency}; no Finance-approved USD conversion rate is available.`);
  return "USD";
}

function metadataAsText(metadata: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata)
    .map(([key, value]) => [key, cleanText(String(value), 300)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
}

function tapCustomerName(customer: z.infer<typeof customerSchema>): string | null {
  return cleanText([customer?.first_name, customer?.middle_name, customer?.last_name].filter((value): value is string => Boolean(value?.trim())).join(" "), 200);
}

function tapCustomerPhone(customer: z.infer<typeof customerSchema>): string | null {
  const countryCode = cleanText(customer?.phone?.country_code === undefined || customer?.phone?.country_code === null ? null : String(customer.phone.country_code), 8)?.replace(/\D/g, "");
  const number = cleanText(customer?.phone?.number === undefined || customer?.phone?.number === null ? null : String(customer.phone.number), 32)?.replace(/\D/g, "");
  return countryCode && number ? `+${countryCode}${number}`.slice(0, 40) : null;
}

function sourceProductReference(input: { metadata: Record<string, string>; product: string | null | undefined; metadataKey: string }): string | null {
  if (input.metadataKey === "product") return cleanText(input.product, 255);
  return cleanText(input.metadata[input.metadataKey], 255);
}

function sourcePlanName(metadata: Record<string, string>): string | null {
  return cleanText(metadata.plan ?? metadata.tier ?? metadata.membership_plan, 100);
}

function chargeStatus(status: string): NormalisedB2cProviderCharge["paymentStatus"] {
  const normalised = status.trim().toUpperCase();
  if (normalised === "CAPTURED") return "succeeded";
  if (["FAILED", "DECLINED", "CANCELLED", "ABANDONED", "RESTRICTED", "TIMEDOUT", "VOID"].includes(normalised)) return "failed";
  return "pending";
}

/** Converts only Tap source fields into the local B2C contract. No value is guessed. */
export function normaliseTapCharge(payload: unknown, productReferenceMetadataKey: string): NormalisedB2cProviderCharge {
  const charge = tapChargeSchema.parse(payload);
  const originalCurrency = requireUsd(charge.currency.toUpperCase());
  const occurredAt = timestampToDate(charge.transaction?.created ?? charge.created);
  const metadata = metadataAsText(charge.metadata ?? {});
  const productReference = sourceProductReference({ metadata, product: charge.product, metadataKey: productReferenceMetadataKey });
  const amount = tapDecimal(charge.amount);
  return {
    chargeId: charge.id,
    customerEmail: validatedEmail(charge.customer?.email),
    customerName: tapCustomerName(charge.customer),
    customerPhone: tapCustomerPhone(charge.customer),
    productReference,
    paymentStatus: chargeStatus(charge.status),
    originalAmount: amount,
    originalCurrency,
    exchangeRateToUsd: "1",
    amountUsd: amount,
    occurredAt: occurredAt.toISOString(),
    occurredOn: bahrainBusinessDate(occurredAt),
    sourceMetadata: {
      ...(productReference ? { product_reference: productReference } : {}),
      ...(cleanText(charge.product, 255) ? { tap_product: cleanText(charge.product, 255)! } : {}),
      ...(sourcePlanName(metadata) ? { provider_plan_name: sourcePlanName(metadata)! } : {}),
      ...(cleanText(charge.description, 300) ? { description: cleanText(charge.description, 300)! } : {}),
      ...(cleanText(charge.reference?.gateway, 255) ? { tap_gateway_reference: cleanText(charge.reference?.gateway, 255)! } : {}),
      ...(charge.reference?.payment !== undefined && charge.reference?.payment !== null ? { tap_payment_reference: String(charge.reference.payment).slice(0, 255) } : {}),
    },
  };
}

/** Keeps Tap refunds separate from their original payment records. */
export function normaliseTapRefund(payload: unknown): NormalisedB2cProviderRefund {
  const refund = tapRefundSchema.parse(payload);
  const status = refund.status.trim().toUpperCase();
  if (!["REFUNDED", "SUCCEEDED", "CAPTURED"].includes(status)) throw new TapRefundNotSucceededError("Tap refund is not completed.");
  const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id ?? null;
  if (!chargeId) throw new TapNormalisationError("Tap refund is missing its source charge.");
  const originalCurrency = requireUsd(refund.currency.toUpperCase());
  const occurredAt = timestampToDate(refund.transaction?.created ?? refund.created);
  const amount = tapDecimal(refund.amount);
  const metadata = metadataAsText(refund.metadata ?? {});
  return {
    refundId: refund.id,
    chargeId,
    originalAmount: amount,
    originalCurrency,
    exchangeRateToUsd: "1",
    amountUsd: amount,
    occurredAt: occurredAt.toISOString(),
    reason: cleanText(refund.description, 300),
    metadata: {
      ...metadata,
      ...(cleanText(refund.reference?.gateway, 255) ? { tap_gateway_reference: cleanText(refund.reference?.gateway, 255)! } : {}),
      ...(refund.reference?.payment !== undefined && refund.reference?.payment !== null ? { tap_payment_reference: String(refund.reference.payment).slice(0, 255) } : {}),
    },
  };
}
