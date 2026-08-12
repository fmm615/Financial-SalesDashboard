import { z } from "zod";
import {
  addStripeCheckoutPlan,
  cleanStripeText,
  normaliseStripeCheckoutPlan,
  validatedStripeEmail,
  validatedStripePhone,
  type NormalisedStripeCharge,
  type StripeCheckoutPlan,
  type StripeTransactionContactSource,
} from "@/lib/integrations/stripe/normalise";

const referenceSchema = z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]);
const chargeReferenceSchema = z.object({
  payment_intent: referenceSchema.nullable().optional(),
  payment_method: referenceSchema.nullable().optional(),
  invoice: referenceSchema.nullable().optional(),
  customer: referenceSchema.nullable().optional(),
  balance_transaction: referenceSchema.nullable().optional(),
}).passthrough();
const contactSchema = z.object({ name: z.string().nullable().optional(), email: z.string().nullable().optional(), phone: z.string().nullable().optional() }).passthrough();
const checkoutContextSchema = z.object({
  session: z.object({ id: z.string().min(1), status: z.string(), customer_details: contactSchema.nullable().optional() }).passthrough(),
  lineItems: z.unknown(),
});
const invoiceSchema = z.object({
  id: z.string().min(1), status: z.string(), currency: z.string().length(3),
  customer_name: z.string().nullable().optional(), customer_email: z.string().nullable().optional(), customer_phone: z.string().nullable().optional(),
  total_tax_amounts: z.array(z.object({ amount: z.number().int().nonnegative() }).passthrough()).default([]),
}).passthrough();
const paymentMethodSchema = z.object({ id: z.string().min(1), billing_details: contactSchema.optional() }).passthrough();
const customerSchema = z.object({ id: z.string().min(1), name: z.string().nullable().optional(), email: z.string().nullable().optional(), phone: z.string().nullable().optional() }).passthrough();
const balanceTransactionSchema = z.object({
  id: z.string().min(1), amount: z.number().int().nonnegative(), fee: z.number().int().nonnegative(), net: z.number().int().nonnegative(),
  currency: z.string().length(3), exchange_rate: z.number().positive().nullable().optional(), status: z.string(),
  fee_details: z.array(z.object({ amount: z.number().int().nonnegative(), type: z.string() }).passthrough()).default([]),
}).passthrough();

export type StripeChargeEnrichmentReferences = {
  paymentIntentId: string | null; paymentMethodId: string | null; checkoutSessionId: string | null;
  invoiceId: string | null; customerId: string | null; balanceTransactionId: string | null;
};
export type StripeContactEvidence = { name: string | null; email: string | null; phone: string | null };
export type StripeTransactionContact = StripeContactEvidence & {
  nameSource: StripeTransactionContactSource | null; emailSource: StripeTransactionContactSource | null; phoneSource: StripeTransactionContactSource | null;
};
export type StripeSettlementEvidence = { grossAmount: string; feeAmount: string; feeTaxAmount: string; netAmount: string; currency: string; exchangeRate: string | null };
export type NormalisedStripeEnrichment = {
  references: StripeChargeEnrichmentReferences;
  transactionContact: StripeTransactionContact;
  chargeContact: StripeContactEvidence;
  checkoutContact: StripeContactEvidence;
  invoiceContact: StripeContactEvidence;
  paymentMethodContact: StripeContactEvidence;
  customerProfileContact: StripeContactEvidence;
  settlement: StripeSettlementEvidence | null;
  providerTax: { amount: string; currency: string } | null;
  plan: StripeCheckoutPlan | null;
  issueCodes: string[];
};
export type StripeEnrichmentPayloads = {
  charge: NormalisedStripeCharge;
  references: StripeChargeEnrichmentReferences;
  checkoutContext?: unknown | null;
  invoice?: unknown | null;
  paymentMethod?: unknown | null;
  customer?: unknown | null;
  balanceTransaction?: unknown | null;
};

function id(reference: string | { id: string } | null | undefined): string | null { return typeof reference === "string" ? reference : reference?.id ?? null; }
function emptyContact(): StripeContactEvidence { return { name: null, email: null, phone: null }; }
function contact(value: z.infer<typeof contactSchema> | null | undefined): StripeContactEvidence {
  return { name: cleanStripeText(value?.name, 200), email: validatedStripeEmail(value?.email), phone: validatedStripePhone(value?.phone) };
}
function minorUnits(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Stripe enrichment contains an invalid monetary amount.");
  const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  if (zeroDecimal.has(currency)) return String(amount);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}

export function stripeChargeEnrichmentReferences(payload: unknown): StripeChargeEnrichmentReferences {
  const charge = chargeReferenceSchema.parse(payload);
  return {
    paymentIntentId: id(charge.payment_intent), paymentMethodId: id(charge.payment_method), checkoutSessionId: null,
    invoiceId: id(charge.invoice), customerId: id(charge.customer), balanceTransactionId: id(charge.balance_transaction),
  };
}

function selected<T extends keyof StripeContactEvidence>(sources: Array<{ contact: StripeContactEvidence; source: StripeTransactionContactSource }>, field: T): { value: StripeContactEvidence[T]; source: StripeTransactionContactSource | null } {
  const match = sources.find((candidate) => candidate.contact[field] !== null);
  return { value: match?.contact[field] ?? null, source: match?.source ?? null };
}

function conflicts(sources: StripeContactEvidence[], selectedContact: StripeTransactionContact): string[] {
  return (["name", "email", "phone"] as const).flatMap((field) => {
    const values = new Set(sources.flatMap((source) => source[field] ? [source[field]!.toLocaleLowerCase("en-US")] : []));
    return values.size > 1 && selectedContact[field] ? [`contact_conflict_${field}`] : [];
  });
}

export function normaliseStripeEnrichment(input: StripeEnrichmentPayloads): NormalisedStripeEnrichment {
  const chargeContact = { name: input.charge.customerName, email: input.charge.customerEmail, phone: input.charge.customerPhone };
  let checkoutContact = emptyContact();
  let plan: StripeCheckoutPlan | null = null;
  let checkoutSessionId: string | null = null;
  if (input.checkoutContext) {
    const checkout = checkoutContextSchema.parse(input.checkoutContext);
    checkoutSessionId = checkout.session.id;
    if (checkout.session.status === "complete") checkoutContact = contact(checkout.session.customer_details);
    plan = normaliseStripeCheckoutPlan({ sessionId: checkout.session.id, lineItems: checkout.lineItems });
  }
  let invoiceContact = emptyContact();
  let providerTax: { amount: string; currency: string } | null = null;
  if (input.invoice) {
    const invoice = invoiceSchema.parse(input.invoice);
    if (invoice.status !== "draft" && invoice.status !== "open") {
      invoiceContact = contact({ name: invoice.customer_name, email: invoice.customer_email, phone: invoice.customer_phone });
      const tax = invoice.total_tax_amounts.reduce((sum, item) => sum + item.amount, 0);
      if (tax > 0) providerTax = { amount: minorUnits(tax, invoice.currency.toUpperCase()), currency: invoice.currency.toUpperCase() };
    }
  }
  const paymentMethodContact = input.paymentMethod ? contact(paymentMethodSchema.parse(input.paymentMethod).billing_details) : emptyContact();
  const customerProfile = input.customer ? customerSchema.parse(input.customer) : null;
  const customerProfileContact = customerProfile ? contact(customerProfile) : emptyContact();
  const chargeSources = (["name", "email", "phone"] as const).reduce<Record<string, StripeTransactionContactSource | null>>((result, field) => ({ ...result, [field]: input.charge[`${field === "name" ? "customerName" : field === "email" ? "customerEmail" : "customerPhone"}Source`] }), {});
  const sources = [
    { contact: chargeContact, source: "charge_billing" as StripeTransactionContactSource },
    { contact: checkoutContact, source: "checkout_session" as StripeTransactionContactSource },
    { contact: invoiceContact, source: "invoice_snapshot" as StripeTransactionContactSource },
  ];
  const name = selected(sources, "name"); const email = selected(sources, "email"); const phone = selected(sources, "phone");
  const transactionContact: StripeTransactionContact = {
    name: name.value, nameSource: name.source === "charge_billing" ? chargeSources.name : name.source,
    email: email.value, emailSource: email.source === "charge_billing" ? chargeSources.email : email.source,
    phone: phone.value, phoneSource: phone.source === "charge_billing" ? chargeSources.phone : phone.source,
  };
  let settlement: StripeSettlementEvidence | null = null;
  if (input.balanceTransaction) {
    const balance = balanceTransactionSchema.parse(input.balanceTransaction);
    if (balance.net !== balance.amount - balance.fee) throw new Error("Stripe returned inconsistent settlement amounts.");
    const currency = balance.currency.toUpperCase();
    const feeTax = balance.fee_details.filter((item) => item.type === "tax").reduce((sum, item) => sum + item.amount, 0);
    settlement = { grossAmount: minorUnits(balance.amount, currency), feeAmount: minorUnits(balance.fee, currency), feeTaxAmount: minorUnits(feeTax, currency), netAmount: minorUnits(balance.net, currency), currency, exchangeRate: balance.exchange_rate == null ? null : String(balance.exchange_rate) };
  }
  return {
    references: { ...input.references, checkoutSessionId }, transactionContact, chargeContact, checkoutContact, invoiceContact,
    paymentMethodContact, customerProfileContact, settlement, providerTax, plan,
    issueCodes: conflicts([chargeContact, checkoutContact, invoiceContact], transactionContact),
  };
}

export function applyStripeTransactionEnrichment(charge: NormalisedStripeCharge, enrichment: NormalisedStripeEnrichment): NormalisedStripeCharge {
  const enriched = {
    ...charge,
    customerName: enrichment.transactionContact.name ?? charge.customerName,
    customerEmail: enrichment.transactionContact.email ?? charge.customerEmail,
    customerPhone: enrichment.transactionContact.phone ?? charge.customerPhone,
    customerNameSource: enrichment.transactionContact.nameSource ?? charge.customerNameSource,
    customerEmailSource: enrichment.transactionContact.emailSource ?? charge.customerEmailSource,
    customerPhoneSource: enrichment.transactionContact.phoneSource ?? charge.customerPhoneSource,
    sourceMetadata: {
      ...charge.sourceMetadata,
      ...(enrichment.transactionContact.nameSource ? { customer_name_source: enrichment.transactionContact.nameSource } : {}),
      ...(enrichment.transactionContact.emailSource ? { customer_email_source: enrichment.transactionContact.emailSource } : {}),
      ...(enrichment.transactionContact.phoneSource ? { customer_phone_source: enrichment.transactionContact.phoneSource } : {}),
    },
  };
  return enrichment.plan ? addStripeCheckoutPlan(enriched, enrichment.plan) : enriched;
}
