import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { formatStripeBillingInterval, normaliseStripeCharge, normaliseStripeCheckoutPlan, normaliseStripeRefund, StripeRefundNotSucceededError } from "@/lib/integrations/stripe/normalise";
import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
import { assertHubSpotReadOnlyRequest } from "@/lib/integrations/hubspot/client";
import { stripeProductMappingSchema } from "@/lib/validation/financial-contracts";
import { b2cPaymentLocalCorrectionSchema } from "@/lib/validation/b2c-review-contracts";
import { isValidStripeSignature } from "@/lib/integrations/stripe/signature";
import { resolveB2cReportingPeriod } from "@/server/repositories/b2c-dashboard-repository";
import { processStripeWebhook, runStripeHistoricalBackfillBatch, runStripeReconciliation } from "@/server/services/sync-stripe";

const charge = {
  id: "ch_123", amount: 12345, currency: "usd", created: 1_754_000_000,
  status: "succeeded", paid: true, captured: true, receipt_email: "member@example.com",
  billing_details: { email: "member@example.com", name: "Member Name" }, metadata: { product_id: "price_membership" },
};

const succeededRefund = { id: "re_123", charge: "ch_123", amount: 1200, currency: "usd", created: 1_754_000_100, status: "succeeded" };

describe("Stripe normalisation and webhook security", () => {
  it("rejects every HubSpot provider write method while allowing only its read search query", () => {
    expect(() => assertHubSpotReadOnlyRequest("/crm/v3/objects/deals/search", "POST")).not.toThrow();
    expect(() => assertHubSpotReadOnlyRequest("/crm/v3/objects/deals/123", "GET")).not.toThrow();
    expect(() => assertHubSpotReadOnlyRequest("/crm/v3/objects/deals/123", "PATCH")).toThrow("read-only");
    expect(() => assertHubSpotReadOnlyRequest("/crm/v3/objects/deals", "POST")).toThrow("read-only");
    expect(() => assertHubSpotReadOnlyRequest("/crm/v3/objects/deals/123", "DELETE")).toThrow("read-only");
  });

  it("uses a canonical six-decimal amount in content fingerprints", () => {
    const baseline = { customerEmail: "member@example.com", categoryCode: "membership", occurredOn: "2026-08-04", providerTransactionId: "ch_123" };
    expect(createB2cDuplicateFingerprint({ ...baseline, amountUsd: "273.9" })).toBe(createB2cDuplicateFingerprint({ ...baseline, amountUsd: "273.900000" }));
  });

  it("requires auditable, local-only product-mapping values", () => {
    expect(stripeProductMappingSchema.safeParse({ productReference: "price_membership", internalProductCode: "membership_annual", internalProductName: "Annual membership", categoryCode: "membership", membershipTier: "annual", reason: "Finance approved the Stripe product classification." }).success).toBe(true);
    expect(stripeProductMappingSchema.safeParse({ productReference: "price_membership", internalProductCode: "Annual Membership", internalProductName: "Annual membership", categoryCode: "membership", reason: "ok" }).success).toBe(false);
  });

  it("requires an audited, verified local B2C correction", () => {
    expect(b2cPaymentLocalCorrectionSchema.safeParse({
      customerEmail: "verified.member@example.com",
      categoryCode: "membership",
      reason: "Verified against the approved payment evidence.",
    }).success).toBe(true);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({
      reason: "Verified against the approved payment evidence.",
    }).success).toBe(false);
    expect(b2cPaymentLocalCorrectionSchema.safeParse({
      customerEmail: "not-an-email",
      reason: "Verified against the approved payment evidence.",
    }).success).toBe(false);
  });

  it("keeps Stripe in B2C, formats minor USD units exactly, and uses the Bahrain business date", () => {
    const payment = normaliseStripeCharge({ ...charge, billing_details: { ...charge.billing_details, phone: "+973 1700 0000" } }, "product_id");
    expect(payment).toMatchObject({ chargeId: "ch_123", customerName: "Member Name", customerEmail: "member@example.com", customerPhone: "+973 1700 0000", originalAmount: "123.45", amountUsd: "123.45", originalCurrency: "USD", productReference: "price_membership" });
    expect(payment.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shows no mobile when Stripe did not put a valid phone directly on the charge", () => {
    expect(normaliseStripeCharge(charge, "product_id").customerPhone).toBeNull();
    expect(normaliseStripeCharge({ ...charge, billing_details: { ...charge.billing_details, phone: "not a phone" } }, "product_id").customerPhone).toBeNull();
  });

  it("uses the direct Stripe Checkout Price and Product name as plan context", () => {
    const plan = normaliseStripeCheckoutPlan({
      sessionId: "cs_123",
      lineItems: { data: [{ price: { id: "price_founding", nickname: null, metadata: {}, recurring: { interval: "year", interval_count: 1 }, product: { id: "prod_membership", name: "Founding Membership", metadata: {} } } }] },
    });
    expect(plan).toEqual({ checkoutSessionId: "cs_123", priceId: "price_founding", productId: "prod_membership", planName: "Founding Membership", billingInterval: "year", billingIntervalCount: 1 });
    expect(formatStripeBillingInterval(plan?.billingInterval ?? null, plan?.billingIntervalCount ?? null)).toBe("Annual");
  });

  it("does not guess a plan from a multi-product Checkout cart", () => {
    expect(normaliseStripeCheckoutPlan({
      sessionId: "cs_multi",
      lineItems: { data: [
        { price: { id: "price_membership", metadata: {}, product: "prod_membership" } },
        { price: { id: "price_add_on", metadata: {}, product: "prod_add_on" } },
      ] },
    })).toBeNull();
  });

  it("does not invent a foreign-currency conversion or accept a non-succeeded refund as a financial record", () => {
    expect(() => normaliseStripeCharge({ ...charge, currency: "bhd" }, "product_id")).toThrow("no verified USD conversion rate");
    expect(() => normaliseStripeRefund({ ...succeededRefund, status: "pending" })).toThrow(StripeRefundNotSucceededError);
  });

  it("retains a missing source email without substituting a Stripe Customer email", () => {
    const payment = normaliseStripeCharge({ ...charge, receipt_email: null, billing_details: {}, customer: "cus_123" }, "product_id");
    expect(payment.customerEmail).toBeNull();
    expect(payment.sourceMetadata.stripe_customer_id).toBe("cus_123");
  });

  it("accepts only a current Stripe signature over the raw body", () => {
    const now = 1_754_000_000_000;
    const body = '{"id":"evt_123"}';
    const timestamp = String(Math.floor(now / 1000) - 10);
    const signature = createHmac("sha256", "whsec_test").update(`${timestamp}.${body}`, "utf8").digest("hex");
    expect(isValidStripeSignature({ payload: body, signature: `t=${timestamp},v1=${signature}`, webhookSecret: "whsec_test", now })).toBe(true);
    expect(isValidStripeSignature({ payload: body, signature: `t=${Number(timestamp) - 301},v1=${signature}`, webhookSecret: "whsec_test", now })).toBe(false);
  });
});

describe("Stripe ingestion orchestration", () => {
  it("enriches a Checkout charge with its direct Price and plan name without writing to Stripe", async () => {
    const repository = { persistCharge: vi.fn().mockResolvedValue({ inserted: true }), persistRefund: vi.fn() };
    const checkoutPlan = { sessionId: "cs_123", lineItems: { data: [{ price: { id: "price_founding", metadata: {}, product: { id: "prod_membership", name: "Founding Membership", metadata: {} } } }] } };
    const source = {
      fetchCharge: vi.fn(), listChargesCreatedSince: vi.fn().mockResolvedValue([{ ...charge, metadata: {}, payment_intent: "pi_123" }]), listRefundsCreatedSince: vi.fn().mockResolvedValue([]),
      fetchCheckoutPlanForPaymentIntent: vi.fn().mockResolvedValue(checkoutPlan),
    };
    await runStripeReconciliation({
      source,
      productReferenceMetadataKey: "product_id",
      repository: { ...repository, startSyncRun: vi.fn().mockResolvedValue({ id: "run-1" }), completeSyncRun: vi.fn(), failSyncRun: vi.fn(), recordSyncError: vi.fn() },
      now: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(source.fetchCheckoutPlanForPaymentIntent).toHaveBeenCalledWith("pi_123");
    expect(repository.persistCharge).toHaveBeenCalledWith(expect.objectContaining({
      productReference: "price_founding",
      sourceMetadata: expect.objectContaining({ stripe_plan_name: "Founding Membership", stripe_price_id: "price_founding" }),
    }));
  });

  it("does not treat a failed retry as a possible financial duplicate", async () => {
    const repository = { persistCharge: vi.fn().mockResolvedValue({ inserted: true }), persistRefund: vi.fn() };
    const source = { fetchCharge: vi.fn(), listChargesCreatedSince: vi.fn(), listRefundsCreatedSince: vi.fn() };
    const result = await runStripeReconciliation({
      source: { ...source, listChargesCreatedSince: vi.fn().mockResolvedValue([{ ...charge, status: "failed", paid: false, captured: false }]), listRefundsCreatedSince: vi.fn().mockResolvedValue([]) },
      productReferenceMetadataKey: "product_id",
      repository: { ...repository, startSyncRun: vi.fn().mockResolvedValue({ id: "run-1" }), completeSyncRun: vi.fn(), failSyncRun: vi.fn(), recordSyncError: vi.fn() },
      now: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(result).toMatchObject({ processed: 1, failed: 0, inserted: 1 });
    expect(repository.persistCharge).toHaveBeenCalledWith(expect.objectContaining({ paymentStatus: "failed" }));
  });

  it("ignores a duplicate webhook event without calling Stripe or writing a payment", async () => {
    const repository = { recordWebhookEvent: vi.fn().mockResolvedValue({ id: "event-row", isNew: false }), markEventCompleted: vi.fn(), failEvent: vi.fn(), persistCharge: vi.fn(), persistRefund: vi.fn() };
    const source = { fetchCharge: vi.fn(), listChargesCreatedSince: vi.fn(), listRefundsCreatedSince: vi.fn() };
    const result = await processStripeWebhook({ event: { id: "evt_123", type: "charge.succeeded", data: { object: charge } }, source, productReferenceMetadataKey: "product_id", repository });
    expect(result).toEqual({ processed: 0, duplicates: 1, ignored: 0 });
    expect(source.fetchCharge).not.toHaveBeenCalled();
    expect(repository.persistCharge).not.toHaveBeenCalled();
  });

  it("persists a no-email charge for review instead of losing the source record", async () => {
    const repository = { recordWebhookEvent: vi.fn().mockResolvedValue({ id: "event-row", isNew: true }), markEventCompleted: vi.fn(), failEvent: vi.fn(), persistCharge: vi.fn().mockResolvedValue({ inserted: true }), persistRefund: vi.fn() };
    const source = { fetchCharge: vi.fn(), listChargesCreatedSince: vi.fn(), listRefundsCreatedSince: vi.fn() };
    const result = await processStripeWebhook({ event: { id: "evt_no_email", type: "charge.succeeded", data: { object: { ...charge, receipt_email: null, billing_details: {} } } }, source, productReferenceMetadataKey: "product_id", repository });
    expect(result).toEqual({ processed: 1, duplicates: 0, ignored: 0 });
    expect(repository.persistCharge).toHaveBeenCalledWith(expect.objectContaining({ customerEmail: null }));
    expect(repository.failEvent).not.toHaveBeenCalled();
  });

  it("waits for a succeeded refund update instead of creating a false financial failure", async () => {
    const repository = { recordWebhookEvent: vi.fn().mockResolvedValue({ id: "event-row", isNew: true }), markEventCompleted: vi.fn(), failEvent: vi.fn(), persistCharge: vi.fn(), persistRefund: vi.fn() };
    const source = { fetchCharge: vi.fn(), listChargesCreatedSince: vi.fn(), listRefundsCreatedSince: vi.fn() };
    const result = await processStripeWebhook({ event: { id: "evt_pending", type: "refund.created", data: { object: { ...succeededRefund, status: "pending" } } }, source, productReferenceMetadataKey: "product_id", repository });
    expect(result).toEqual({ processed: 1, duplicates: 0, ignored: 0 });
    expect(repository.markEventCompleted).toHaveBeenCalledWith("event-row");
    expect(repository.failEvent).not.toHaveBeenCalled();
    expect(source.fetchCharge).not.toHaveBeenCalled();
  });

  it("reads exactly the required 48-hour reconciliation window and continues after an invalid source row", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const repository = {
      startSyncRun: vi.fn().mockResolvedValue({ id: "run-1" }), completeSyncRun: vi.fn(), failSyncRun: vi.fn(), recordSyncError: vi.fn(), persistCharge: vi.fn().mockResolvedValue({ inserted: true }), persistRefund: vi.fn().mockResolvedValue({ inserted: true }),
    };
    const source = { fetchCharge: vi.fn().mockResolvedValue(charge), listChargesCreatedSince: vi.fn().mockResolvedValue([charge, { ...charge, id: "ch_bad", currency: "bhd" }]), listRefundsCreatedSince: vi.fn().mockResolvedValue([succeededRefund]) };
    const result = await runStripeReconciliation({ source, productReferenceMetadataKey: "product_id", repository, now });
    expect(result.lookbackStart.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(source.listChargesCreatedSince).toHaveBeenCalledWith(result.lookbackStart);
    expect(result).toMatchObject({ processed: 2, failed: 1, inserted: 2 });
    expect(repository.recordSyncError).toHaveBeenCalledWith("run-1", expect.any(Error), "Stripe charge ch_bad");
  });

  it("imports all Stripe history in resumable charge then refund phases", async () => {
    const repository = {
      persistCharge: vi.fn().mockResolvedValue({ inserted: true }),
      persistRefund: vi.fn().mockResolvedValue({ inserted: true }),
      getOrStartHistoricalBackfill: vi.fn()
        .mockResolvedValueOnce({ id: "history-1", continuationCursor: null, recordsProcessed: 0, recordsFailed: 0, completed: false })
        .mockResolvedValueOnce({ id: "history-1", continuationCursor: "refunds:", recordsProcessed: 1, recordsFailed: 0, completed: false }),
      finishHistoricalBackfillBatch: vi.fn()
        .mockResolvedValueOnce({ id: "history-1", continuationCursor: "refunds:", recordsProcessed: 1, recordsFailed: 0, completed: false })
        .mockResolvedValueOnce({ id: "history-1", continuationCursor: null, recordsProcessed: 2, recordsFailed: 0, completed: true }),
      failSyncRun: vi.fn(),
      recordSyncError: vi.fn(),
    };
    const source = {
      fetchCharge: vi.fn().mockResolvedValue(charge),
      listChargesPage: vi.fn().mockResolvedValue({ records: [charge], nextCursor: null }),
      listRefundsPage: vi.fn().mockResolvedValue({ records: [succeededRefund], nextCursor: null }),
    };

    const chargeBatch = await runStripeHistoricalBackfillBatch({ source, productReferenceMetadataKey: "product_id", repository, restartCompleted: true });
    expect(chargeBatch).toMatchObject({ processed: 1, failed: 0, totalProcessed: 1, hasMore: true });
    expect(repository.finishHistoricalBackfillBatch).toHaveBeenCalledWith(expect.objectContaining({ nextCursor: "refunds:" }));

    const refundBatch = await runStripeHistoricalBackfillBatch({ source, productReferenceMetadataKey: "product_id", repository, restartCompleted: true });
    expect(refundBatch).toMatchObject({ processed: 1, failed: 0, totalProcessed: 2, hasMore: false });
    expect(repository.persistRefund).toHaveBeenCalledTimes(1);
  });
});

describe("B2C period handling", () => {
  it("uses the requested month and a live current-month fallback rather than a fixed end date", () => {
    expect(resolveB2cReportingPeriod("2027-01", new Date("2026-08-02T12:00:00.000Z"))).toMatchObject({ month: "2027-01", monthStart: "2027-01-01", monthEnd: "2027-01-31" });
    expect(resolveB2cReportingPeriod(undefined, new Date("2027-04-02T12:00:00.000Z")).month).toBe("2027-04");
    expect(resolveB2cReportingPeriod("all", new Date("2027-04-02T12:00:00.000Z"))).toMatchObject({ month: "all", monthLabel: "All time", isAllTime: true });
  });
});
