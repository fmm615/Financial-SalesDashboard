import { z } from "zod";

const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

const metadataSchema = z.record(z.string(), z.string()).default({});
const chargeContactSchema = z.object({
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});
const stripeIdReferenceSchema = z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]);
const chargeSchema = z.object({
  id: z.string().min(1), amount: z.number().int().positive(), currency: z.string().length(3), created: z.number().int().nonnegative(),
  status: z.string(), paid: z.boolean(), captured: z.boolean(), amount_refunded: z.number().int().nonnegative().optional(), receipt_email: z.string().nullable().optional(),
  billing_details: chargeContactSchema.optional(),
  shipping: chargeContactSchema.nullable().optional(),
  customer: stripeIdReferenceSchema.nullable().optional(),
  metadata: metadataSchema.optional(), payment_intent: stripeIdReferenceSchema.nullable().optional(), payment_method: stripeIdReferenceSchema.nullable().optional(),
  invoice: stripeIdReferenceSchema.nullable().optional(), balance_transaction: stripeIdReferenceSchema.nullable().optional(), description: z.string().nullable().optional(),
  outcome: z.object({ seller_message: z.string().nullable().optional() }).nullable().optional(),
}).passthrough();
const refundSchema = z.object({
  id: z.string().min(1), charge: z.string().nullable(), amount: z.number().int().positive(), currency: z.string().length(3),
  created: z.number().int().nonnegative(), status: z.string().nullable().optional(), reason: z.string().nullable().optional(), metadata: metadataSchema.optional(),
  balance_transaction: stripeIdReferenceSchema.nullable().optional(),
}).passthrough();
const stripeProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  metadata: metadataSchema.optional(),
}).passthrough();
const stripePriceSchema = z.object({
  id: z.string().min(1),
  nickname: z.string().nullable().optional(),
  metadata: metadataSchema.optional(),
  recurring: z.object({
    interval: z.enum(["day", "week", "month", "year"]),
    interval_count: z.number().int().positive().optional(),
  }).nullable().optional(),
  product: z.union([z.string().min(1), stripeProductSchema]).nullable().optional(),
}).passthrough();
const checkoutLineItemsSchema = z.object({
  sessionId: z.string().min(1),
  lineItems: z.object({
    data: z.array(z.object({ price: stripePriceSchema.nullable().optional() }).passthrough()),
  }).passthrough(),
});

export type StripePaymentStatus = "succeeded" | "failed" | "pending";
export type StripeTransactionContactSource = "charge_receipt" | "charge_billing" | "charge_shipping" | "checkout_session" | "invoice_snapshot";
export type NormalisedStripeCharge = {
  chargeId: string; customerEmail: string | null; customerName: string | null; customerPhone: string | null; productReference: string | null; paymentStatus: StripePaymentStatus;
  customerEmailSource: StripeTransactionContactSource | null; customerNameSource: StripeTransactionContactSource | null; customerPhoneSource: StripeTransactionContactSource | null;
  originalAmount: string; originalCurrency: string; exchangeRateToUsd: "1"; amountUsd: string; occurredAt: string; occurredOn: string;
  description: string | null; sellerMessage: string | null; cardholderName: string | null; amountRefunded: string;
  sourceMetadata: Record<string, string>;
};
export type NormalisedStripeRefund = { refundId: string; chargeId: string; originalAmount: string; originalCurrency: string; exchangeRateToUsd: "1"; amountUsd: string; occurredAt: string; reason: string | null; balanceTransactionId: string | null; metadata: Record<string, string> };
export type StripeCheckoutPlan = {
  checkoutSessionId: string;
  priceId: string;
  productId: string | null;
  planName: string | null;
  billingInterval: "day" | "week" | "month" | "year" | null;
  billingIntervalCount: number | null;
};

export class StripeNormalisationError extends Error {}

/** A non-succeeded refund is a provider lifecycle state, not a financial refund. */
export class StripeRefundNotSucceededError extends StripeNormalisationError {}

export function cleanStripeText(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

export function validatedStripeEmail(value: string | null | undefined): string | null {
  const email = cleanStripeText(value, 320)?.toLowerCase();
  return email && z.string().email().safeParse(email).success ? email : null;
}

/** Keep only a phone Stripe put directly on this Charge; never infer one from another system or profile. */
export function validatedStripePhone(value: string | null | undefined): string | null {
  const phone = cleanStripeText(value, 40);
  return phone && /^[+\d][\d\s().-]{4,39}$/.test(phone) ? phone : null;
}

/** Returns the provider Customer ID when the Charge contains one; no data is persisted from this helper. */
export function stripeChargeCustomerId(payload: unknown): string | null {
  const customer = chargeSchema.parse(payload).customer;
  return stripeReferenceId(customer);
}

function stripeReferenceId(reference: string | { id: string } | null | undefined): string | null {
  return typeof reference === "string" ? reference : reference?.id ?? null;
}

function stripeMinorAmountToDecimal(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new StripeNormalisationError("Stripe returned an invalid payment amount.");
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return String(amount);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

function stripeMinorNonnegativeAmountToDecimal(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new StripeNormalisationError("Stripe returned an invalid refunded amount.");
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

function planMetadataValue(metadata: Record<string, string>): string | null {
  return cleanStripeText(metadata.plan ?? metadata.tier ?? metadata.membership_plan, 100);
}

/** Formats only Stripe's direct Price.recurring fields; it never infers a cadence. */
export function formatStripeBillingInterval(interval: StripeCheckoutPlan["billingInterval"], count: number | null): string | null {
  if (!interval) return null;
  const intervalCount = count ?? 1;
  if (intervalCount === 1) {
    return { day: "Daily", week: "Weekly", month: "Monthly", year: "Annual" }[interval];
  }
  return `Every ${intervalCount} ${interval}${intervalCount === 1 ? "" : "s"}`;
}

/** Reads a Checkout line item's stable Price reference and source plan name. */
export function normaliseStripeCheckoutPlan(payload: unknown): StripeCheckoutPlan | null {
  const result = checkoutLineItemsSchema.safeParse(payload);
  if (!result.success) return null;
  // One B2C payment currently has one reportable classification. A cart with
  // multiple different Prices needs an approved allocation rule, so never
  // silently classify it from whichever line happens to be first.
  const prices = result.data.lineItems.data.flatMap((item) => item.price ? [item.price] : []);
  if (prices.length !== 1) return null;
  const [price] = prices;
  if (!price) return null;
  const product = typeof price.product === "object" && price.product ? price.product : null;
  return {
    checkoutSessionId: result.data.sessionId,
    priceId: price.id,
    productId: product?.id ?? (typeof price.product === "string" ? price.product : null),
    planName: planMetadataValue(price.metadata ?? {}) ?? cleanStripeText(price.nickname, 100) ?? (product ? planMetadataValue(product.metadata ?? {}) ?? cleanStripeText(product.name, 100) : null),
    billingInterval: price.recurring?.interval ?? null,
    billingIntervalCount: price.recurring?.interval_count ?? null,
  };
}

/** Adds only direct Stripe Checkout data to a normalised Charge; it does not change the provider. */
export function addStripeCheckoutPlan(charge: NormalisedStripeCharge, plan: StripeCheckoutPlan): NormalisedStripeCharge {
  return {
    ...charge,
    // An existing configured Charge metadata value is intentionally preferred.
    // Otherwise the Stripe Price ID is a stable, direct product reference.
    productReference: charge.productReference ?? plan.priceId,
    sourceMetadata: {
      ...charge.sourceMetadata,
      ...(charge.productReference ? {} : { product_reference: plan.priceId }),
      stripe_checkout_session_id: plan.checkoutSessionId,
      stripe_price_id: plan.priceId,
      ...(plan.productId ? { stripe_product_id: plan.productId } : {}),
      ...(plan.planName ? { stripe_plan_name: plan.planName } : {}),
      ...(plan.planName ? { provider_plan_name: plan.planName } : {}),
      ...(plan.billingInterval ? { stripe_billing_interval: plan.billingInterval } : {}),
      ...(plan.billingIntervalCount ? { stripe_billing_interval_count: String(plan.billingIntervalCount) } : {}),
    },
  };
}

/** Converts only the provider fields PLAYBOOK persists; raw Stripe payloads never enter the database. */
export function normaliseStripeCharge(payload: unknown, productReferenceMetadataKey: string): NormalisedStripeCharge {
  const charge = chargeSchema.parse(payload);
  const originalCurrency = requireUsd(charge.currency.toUpperCase());
  const occurredAt = new Date(charge.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw new StripeNormalisationError("Stripe charge has an invalid created timestamp.");
  const receiptEmail = validatedStripeEmail(charge.receipt_email);
  const billingEmail = validatedStripeEmail(charge.billing_details?.email);
  const shippingEmail = validatedStripeEmail(charge.shipping?.email);
  const customerEmail = receiptEmail ?? billingEmail ?? shippingEmail;
  const billingName = cleanStripeText(charge.billing_details?.name, 200);
  const shippingName = cleanStripeText(charge.shipping?.name, 200);
  const customerName = billingName ?? shippingName;
  const billingPhone = validatedStripePhone(charge.billing_details?.phone);
  const shippingPhone = validatedStripePhone(charge.shipping?.phone);
  const customerPhone = billingPhone ?? shippingPhone;
  const amount = stripeMinorAmountToDecimal(charge.amount, originalCurrency);
  const amountRefunded = stripeMinorNonnegativeAmountToDecimal(charge.amount_refunded ?? 0, originalCurrency);
  if ((charge.amount_refunded ?? 0) > charge.amount) throw new StripeNormalisationError("Stripe returned a refunded amount greater than the charge amount.");
  const metadata = charge.metadata ?? {};
  const productReference = cleanStripeText(metadata[productReferenceMetadataKey], 255);
  const paymentStatus: StripePaymentStatus = charge.status === "succeeded" && charge.paid && charge.captured ? "succeeded" : charge.status === "failed" ? "failed" : "pending";
  const description = cleanStripeText(charge.description, 300);
  const sellerMessage = cleanStripeText(charge.outcome?.seller_message, 300);
  return {
    chargeId: charge.id,
    customerEmail,
    customerName,
    customerPhone,
    customerEmailSource: receiptEmail ? "charge_receipt" : billingEmail ? "charge_billing" : shippingEmail ? "charge_shipping" : null,
    customerNameSource: billingName ? "charge_billing" : shippingName ? "charge_shipping" : null,
    customerPhoneSource: billingPhone ? "charge_billing" : shippingPhone ? "charge_shipping" : null,
    productReference,
    paymentStatus,
    originalAmount: amount, originalCurrency, exchangeRateToUsd: "1", amountUsd: amount, occurredAt: occurredAt.toISOString(), occurredOn: bahrainBusinessDate(occurredAt),
    description, sellerMessage, cardholderName: billingName, amountRefunded,
    sourceMetadata: {
      ...(stripeReferenceId(charge.payment_intent) ? { payment_intent_id: stripeReferenceId(charge.payment_intent)! } : {}),
      ...(stripeReferenceId(charge.payment_method) ? { payment_method_id: stripeReferenceId(charge.payment_method)! } : {}),
      ...(stripeReferenceId(charge.invoice) ? { invoice_id: stripeReferenceId(charge.invoice)! } : {}),
      ...(stripeReferenceId(charge.balance_transaction) ? { balance_transaction_id: stripeReferenceId(charge.balance_transaction)! } : {}),
      ...(stripeChargeCustomerId(charge) ? { stripe_customer_id: stripeChargeCustomerId(charge)! } : {}),
      ...(productReference ? { product_reference: productReference } : {}),
      ...(description ? { description } : {}),
      ...(customerName ? { customer_name_source: (billingName ? "charge_billing" : "charge_shipping") } : {}),
      ...(customerEmail ? { customer_email_source: receiptEmail ? "charge_receipt" : billingEmail ? "charge_billing" : "charge_shipping" } : {}),
      ...(customerPhone ? { customer_phone_source: billingPhone ? "charge_billing" : "charge_shipping" } : {}),
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
  return { refundId: refund.id, chargeId: refund.charge, originalAmount: stripeMinorAmountToDecimal(refund.amount, originalCurrency), originalCurrency, exchangeRateToUsd: "1", amountUsd: stripeMinorAmountToDecimal(refund.amount, originalCurrency), occurredAt: occurredAt.toISOString(), reason: cleanStripeText(refund.reason, 300), balanceTransactionId: stripeReferenceId(refund.balance_transaction), metadata: {} };
}

const stripeEventSchema = z.object({ id: z.string().min(1), type: z.string().min(1), data: z.object({ object: z.unknown() }) }).passthrough();
export type StripeWebhookEvent = z.infer<typeof stripeEventSchema>;
export function parseStripeWebhookEvent(payload: unknown): StripeWebhookEvent { return stripeEventSchema.parse(payload); }
