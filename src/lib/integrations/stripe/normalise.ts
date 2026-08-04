import { z } from "zod";

const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

const metadataSchema = z.record(z.string(), z.string()).default({});
const chargeSchema = z.object({
  id: z.string().min(1), amount: z.number().int().positive(), currency: z.string().length(3), created: z.number().int().nonnegative(),
  status: z.string(), paid: z.boolean(), captured: z.boolean(), receipt_email: z.string().nullable().optional(),
  billing_details: z.object({ email: z.string().nullable().optional(), name: z.string().nullable().optional() }).optional(),
  customer: z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]).nullable().optional(),
  metadata: metadataSchema.optional(), payment_intent: z.string().nullable().optional(), invoice: z.string().nullable().optional(), description: z.string().nullable().optional(),
}).passthrough();
const refundSchema = z.object({
  id: z.string().min(1), charge: z.string().nullable(), amount: z.number().int().positive(), currency: z.string().length(3),
  created: z.number().int().nonnegative(), status: z.string().nullable().optional(), reason: z.string().nullable().optional(), metadata: metadataSchema.optional(),
}).passthrough();

export type StripePaymentStatus = "succeeded" | "failed" | "pending";
export type NormalisedStripeCharge = {
  chargeId: string; customerEmail: string; customerName: string | null; productReference: string | null; paymentStatus: StripePaymentStatus;
  originalAmount: string; originalCurrency: string; exchangeRateToUsd: "1"; amountUsd: string; occurredAt: string; occurredOn: string;
  sourceMetadata: Record<string, string>;
};
export type NormalisedStripeRefund = { refundId: string; chargeId: string; originalAmount: string; originalCurrency: string; exchangeRateToUsd: "1"; amountUsd: string; occurredAt: string; reason: string | null; metadata: Record<string, string> };

export class StripeNormalisationError extends Error {}

/** A non-succeeded refund is a provider lifecycle state, not a financial refund. */
export class StripeRefundNotSucceededError extends StripeNormalisationError {}

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function validatedEmail(value: string | null | undefined): string | null {
  const email = cleanText(value, 320)?.toLowerCase();
  return email && z.string().email().safeParse(email).success ? email : null;
}

/** Returns the provider Customer ID when the Charge contains one; no data is persisted from this helper. */
export function stripeChargeCustomerId(payload: unknown): string | null {
  const customer = chargeSchema.parse(payload).customer;
  return typeof customer === "string" ? customer : customer?.id ?? null;
}

function stripeMinorAmountToDecimal(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new StripeNormalisationError("Stripe returned an invalid payment amount.");
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return String(amount);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

function bahrainBusinessDate(occurredAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bahrain", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(occurredAt);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requireUsd(currency: string): "USD" {
  if (currency !== "USD") throw new StripeNormalisationError(`Stripe charge uses ${currency}; no verified USD conversion rate is available.`);
  return "USD";
}

/** Converts only the provider fields PLAYBOOK persists; raw Stripe payloads never enter the database. */
export function normaliseStripeCharge(payload: unknown, productReferenceMetadataKey: string): NormalisedStripeCharge {
  const charge = chargeSchema.parse(payload);
  const originalCurrency = requireUsd(charge.currency.toUpperCase());
  const occurredAt = new Date(charge.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw new StripeNormalisationError("Stripe charge has an invalid created timestamp.");
  const customerEmail = validatedEmail(charge.receipt_email ?? charge.billing_details?.email);
  if (!customerEmail) throw new StripeNormalisationError("Stripe charge is missing a valid customer email.");
  const amount = stripeMinorAmountToDecimal(charge.amount, originalCurrency);
  const metadata = charge.metadata ?? {};
  const productReference = cleanText(metadata[productReferenceMetadataKey], 255);
  const paymentStatus: StripePaymentStatus = charge.status === "succeeded" && charge.paid && charge.captured ? "succeeded" : charge.status === "failed" ? "failed" : "pending";
  return {
    chargeId: charge.id, customerEmail, customerName: cleanText(charge.billing_details?.name, 200), productReference, paymentStatus,
    originalAmount: amount, originalCurrency, exchangeRateToUsd: "1", amountUsd: amount, occurredAt: occurredAt.toISOString(), occurredOn: bahrainBusinessDate(occurredAt),
    sourceMetadata: {
      ...(cleanText(charge.payment_intent, 255) ? { payment_intent_id: cleanText(charge.payment_intent, 255)! } : {}),
      ...(cleanText(charge.invoice, 255) ? { invoice_id: cleanText(charge.invoice, 255)! } : {}),
      ...(stripeChargeCustomerId(charge) ? { stripe_customer_id: stripeChargeCustomerId(charge)! } : {}),
      ...(productReference ? { product_reference: productReference } : {}),
      ...(cleanText(charge.description, 300) ? { description: cleanText(charge.description, 300)! } : {}),
    },
  };
}

export function normaliseStripeRefund(payload: unknown): NormalisedStripeRefund {
  const refund = refundSchema.parse(payload);
  if (refund.status && refund.status !== "succeeded") throw new StripeRefundNotSucceededError("Stripe refund is not succeeded.");
  if (!refund.charge) throw new StripeNormalisationError("Stripe refund is missing its source charge.");
  const originalCurrency = requireUsd(refund.currency.toUpperCase());
  const occurredAt = new Date(refund.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw new StripeNormalisationError("Stripe refund has an invalid created timestamp.");
  return { refundId: refund.id, chargeId: refund.charge, originalAmount: stripeMinorAmountToDecimal(refund.amount, originalCurrency), originalCurrency, exchangeRateToUsd: "1", amountUsd: stripeMinorAmountToDecimal(refund.amount, originalCurrency), occurredAt: occurredAt.toISOString(), reason: cleanText(refund.reason, 300), metadata: {} };
}

const stripeEventSchema = z.object({ id: z.string().min(1), type: z.string().min(1), data: z.object({ object: z.unknown() }) }).passthrough();
export type StripeWebhookEvent = z.infer<typeof stripeEventSchema>;
export function parseStripeWebhookEvent(payload: unknown): StripeWebhookEvent { return stripeEventSchema.parse(payload); }
