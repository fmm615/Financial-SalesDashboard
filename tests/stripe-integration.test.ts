import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normaliseStripeCharge, normaliseStripeRefund, StripeRefundNotSucceededError } from "@/lib/integrations/stripe/normalise";
import { isValidStripeSignature } from "@/lib/integrations/stripe/signature";
import { resolveB2cReportingPeriod } from "@/server/repositories/b2c-dashboard-repository";
import { processStripeWebhook, runStripeReconciliation } from "@/server/services/sync-stripe";

const charge = {
  id: "ch_123", amount: 12345, currency: "usd", created: 1_754_000_000,
  status: "succeeded", paid: true, captured: true, receipt_email: "member@example.com",
  billing_details: { email: "member@example.com", name: "Member Name" }, metadata: { product_id: "price_membership" },
};

const succeededRefund = { id: "re_123", charge: "ch_123", amount: 1200, currency: "usd", created: 1_754_000_100, status: "succeeded" };

describe("Stripe normalisation and webhook security", () => {
  it("keeps Stripe in B2C, formats minor USD units exactly, and uses the Bahrain business date", () => {
    const payment = normaliseStripeCharge(charge, "product_id");
    expect(payment).toMatchObject({ chargeId: "ch_123", customerEmail: "member@example.com", originalAmount: "123.45", amountUsd: "123.45", originalCurrency: "USD", productReference: "price_membership" });
    expect(payment.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("does not invent a foreign-currency conversion or accept a non-succeeded refund as a financial record", () => {
    expect(() => normaliseStripeCharge({ ...charge, currency: "bhd" }, "product_id")).toThrow("no verified USD conversion rate");
    expect(() => normaliseStripeRefund({ ...succeededRefund, status: "pending" })).toThrow(StripeRefundNotSucceededError);
  });

  it("does not substitute a Stripe Customer email for an email missing from the Charge", () => {
    expect(() => normaliseStripeCharge({ ...charge, receipt_email: null, billing_details: {}, customer: "cus_123" }, "product_id")).toThrow("missing a valid customer email");
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
});

describe("B2C period handling", () => {
  it("uses the requested month and a live current-month fallback rather than a fixed end date", () => {
    expect(resolveB2cReportingPeriod("2027-01", new Date("2026-08-02T12:00:00.000Z"))).toMatchObject({ month: "2027-01", monthStart: "2027-01-01", monthEnd: "2027-01-31" });
    expect(resolveB2cReportingPeriod(undefined, new Date("2027-04-02T12:00:00.000Z")).month).toBe("2027-04");
  });
});
