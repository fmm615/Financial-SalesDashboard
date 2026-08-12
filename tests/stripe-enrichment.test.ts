import { describe, expect, it } from "vitest";
import {
  applyStripeTransactionEnrichment,
  normaliseStripeEnrichment,
  stripeChargeEnrichmentReferences,
} from "@/lib/integrations/stripe/enrichment";
import { normaliseStripeCharge } from "@/lib/integrations/stripe/normalise";

const rawCharge = {
  id: "ch_123",
  amount: 5042,
  currency: "usd",
  created: 1_754_000_000,
  status: "succeeded",
  paid: true,
  captured: true,
  receipt_email: null,
  billing_details: {},
  shipping: null,
  payment_intent: "pi_123",
  payment_method: "pm_123",
  invoice: "in_123",
  customer: "cus_123",
  balance_transaction: "txn_123",
  metadata: {},
};

describe("Stripe read-only enrichment normalisation", () => {
  it("extracts only stable IDs from string or expanded Charge references", () => {
    expect(stripeChargeEnrichmentReferences({
      ...rawCharge,
      payment_method: { id: "pm_expanded", billing_details: { email: "ignored@example.com" } },
      customer: { id: "cus_expanded", email: "ignored@example.com" },
    })).toEqual({
      paymentIntentId: "pi_123",
      paymentMethodId: "pm_expanded",
      checkoutSessionId: null,
      invoiceId: "in_123",
      customerId: "cus_expanded",
      balanceTransactionId: "txn_123",
    });
  });

  it("uses Charge, completed Checkout, then finalized Invoice contacts while retaining mutable fallbacks separately", () => {
    const charge = normaliseStripeCharge({
      ...rawCharge,
      receipt_email: "charge@example.com",
      billing_details: { name: "Charge Name" },
    }, "product_id");
    const enrichment = normaliseStripeEnrichment({
      charge,
      references: stripeChargeEnrichmentReferences(rawCharge),
      checkoutContext: {
        session: { id: "cs_123", status: "complete", customer_details: { name: "Checkout Name", email: "checkout@example.com", phone: "+973 1700 0000" } },
        lineItems: { data: [{ price: { id: "price_monthly", nickname: "Monthly membership", metadata: {}, recurring: { interval: "month" }, product: "prod_membership" } }] },
      },
      invoice: { id: "in_123", status: "paid", currency: "usd", customer_name: "Invoice Name", customer_email: "invoice@example.com", customer_phone: "+973 1800 0000", total_tax_amounts: [{ amount: 500 }] },
      paymentMethod: { id: "pm_123", billing_details: { name: "Payment Method Name", email: "mutable-pm@example.com", phone: "+973 1900 0000" } },
      customer: { id: "cus_123", name: "Current Profile", email: "current-profile@example.com", phone: "+973 1600 0000" },
      balanceTransaction: { id: "txn_123", amount: 18518, fee: 1378, net: 17140, currency: "aed", exchange_rate: 3.672352, status: "available", fee_details: [{ amount: 50, type: "tax" }] },
    });

    expect(enrichment.transactionContact).toMatchObject({
      name: "Charge Name",
      nameSource: "charge_billing",
      email: "charge@example.com",
      emailSource: "charge_receipt",
      phone: "+973 1700 0000",
      phoneSource: "checkout_session",
    });
    expect(enrichment.paymentMethodContact.email).toBe("mutable-pm@example.com");
    expect(enrichment.customerProfileContact.email).toBe("current-profile@example.com");
    expect(enrichment.settlement).toEqual({ grossAmount: "185.18", feeAmount: "13.78", feeTaxAmount: "0.50", netAmount: "171.40", currency: "AED", exchangeRate: "3.672352" });
    expect(enrichment.providerTax).toEqual({ amount: "5.00", currency: "USD" });
    expect(enrichment.plan).toMatchObject({ priceId: "price_monthly", planName: "Monthly membership" });
  });

  it("fills missing transaction fields from snapshots but never from mutable Stripe objects", () => {
    const charge = normaliseStripeCharge(rawCharge, "product_id");
    const snapshotEnrichment = normaliseStripeEnrichment({
      charge,
      references: stripeChargeEnrichmentReferences(rawCharge),
      checkoutContext: { session: { id: "cs_123", status: "complete", customer_details: { email: "checkout@example.com" } }, lineItems: { data: [] } },
      invoice: { id: "in_123", status: "paid", currency: "usd", customer_name: "Invoice Name", customer_phone: "+973 1800 0000", total_tax_amounts: [] },
      paymentMethod: { id: "pm_123", billing_details: { email: "mutable-pm@example.com" } },
      customer: { id: "cus_123", email: "current-profile@example.com" },
    });
    expect(applyStripeTransactionEnrichment(charge, snapshotEnrichment)).toMatchObject({
      customerName: "Invoice Name",
      customerEmail: "checkout@example.com",
      customerPhone: "+973 1800 0000",
    });

    const mutableOnly = normaliseStripeEnrichment({
      charge,
      references: stripeChargeEnrichmentReferences(rawCharge),
      paymentMethod: { id: "pm_123", billing_details: { name: "Mutable Name", email: "mutable-pm@example.com" } },
      customer: { id: "cus_123", name: "Profile Name", email: "current-profile@example.com" },
    });
    expect(applyStripeTransactionEnrichment(charge, mutableOnly)).toMatchObject({ customerName: null, customerEmail: null, customerPhone: null });
  });

  it("ignores incomplete snapshots, records transaction conflicts, and rejects inconsistent settlement math", () => {
    const charge = normaliseStripeCharge({ ...rawCharge, billing_details: { email: "billing@example.com" } }, "product_id");
    const enrichment = normaliseStripeEnrichment({
      charge,
      references: stripeChargeEnrichmentReferences(rawCharge),
      checkoutContext: { session: { id: "cs_open", status: "open", customer_details: { email: "open@example.com" } }, lineItems: { data: [] } },
      invoice: { id: "in_draft", status: "draft", currency: "usd", customer_email: "draft@example.com", total_tax_amounts: [] },
    });
    expect(enrichment.transactionContact.email).toBe("billing@example.com");
    expect(enrichment.checkoutContact.email).toBeNull();
    expect(enrichment.invoiceContact.email).toBeNull();

    const conflict = normaliseStripeEnrichment({
      charge,
      references: stripeChargeEnrichmentReferences(rawCharge),
      checkoutContext: { session: { id: "cs_123", status: "complete", customer_details: { email: "different@example.com" } }, lineItems: { data: [] } },
    });
    expect(conflict.issueCodes).toContain("contact_conflict_email");

    expect(() => normaliseStripeEnrichment({
      charge,
      references: stripeChargeEnrichmentReferences(rawCharge),
      balanceTransaction: { id: "txn_bad", amount: 1000, fee: 100, net: 950, currency: "usd", exchange_rate: null, status: "available", fee_details: [] },
    })).toThrow("inconsistent settlement amounts");
  });
});
