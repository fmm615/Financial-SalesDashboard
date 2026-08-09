import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normaliseTapCharge, normaliseTapRefund, TapRefundNotSucceededError } from "@/lib/integrations/tap/normalise";
import { isValidTapWebhookSignature } from "@/lib/integrations/tap/signature";
import { TapClient } from "@/lib/integrations/tap/client";
import { processTapWebhook, runTapHistoricalBackfillBatch, runTapReconciliation } from "@/server/services/sync-tap";

const charge = {
  id: "chg_TS01", status: "CAPTURED", amount: "50.420", currency: "USD", created: "2026-08-04T08:00:00.000Z",
  customer: { first_name: "Khansa", last_name: "Khatoon", email: "khansa@example.com", phone: { country_code: "973", number: "16825644112" } },
  metadata: { product_id: "tap_price_founding", plan: "Founding Membership" }, reference: { gateway: "gw_1", payment: "p_1" },
};
const refund = { id: "ref_TS01", status: "REFUNDED", amount: "10.000", currency: "USD", charge: "chg_TS01", created: "2026-08-04T09:00:00.000Z", reference: { gateway: "gw_2", payment: "p_2" } };

describe("Tap normalisation and signed event processing", () => {
  it("keeps direct Tap fields, uses Bahrain business date, and never guesses a product", () => {
    const payment = normaliseTapCharge(charge, "product_id");
    expect(payment).toMatchObject({ chargeId: "chg_TS01", paymentStatus: "succeeded", customerName: "Khansa Khatoon", customerEmail: "khansa@example.com", customerPhone: "+97316825644112", productReference: "tap_price_founding", originalAmount: "50.42", amountUsd: "50.42", originalCurrency: "USD" });
    expect(payment.sourceMetadata).toMatchObject({ provider_plan_name: "Founding Membership", tap_gateway_reference: "gw_1" });
    expect(payment.occurredOn).toMatch(/^2026-08-04$/);
  });

  it("does not invent foreign-currency reporting or treat a pending refund as completed", () => {
    expect(() => normaliseTapCharge({ ...charge, currency: "BHD" }, "product_id")).toThrow("no Finance-approved USD conversion rate");
    expect(() => normaliseTapRefund({ ...refund, status: "PENDING" })).toThrow(TapRefundNotSucceededError);
  });

  it("uses only the documented fields for Tap refund list requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ refunds: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TapClient({ apiBaseUrl: "https://api.tap.company", apiKey: "sk_test", productReferenceMetadataKey: "product_id" });
    await client.listRefundsPage();
    expect(fetchMock).toHaveBeenCalledWith("https://api.tap.company/v2/refunds/list", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ limit: 50 }),
    }));
    vi.unstubAllGlobals();
  });

  it("treats Tap's explicit no-refunds response as an empty refund history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Refunds not found" }), { status: 400 })));
    const client = new TapClient({ apiBaseUrl: "https://api.tap.company", apiKey: "sk_test", productReferenceMetadataKey: "product_id" });
    await expect(client.listRefundsPage()).resolves.toEqual({ records: [], nextCursor: null });
    vi.unstubAllGlobals();
  });

  it("accepts only Tap's signed hashstring", () => {
    const signed = "x_idchg_TS01x_amount50.42x_currencyUSDx_gateway_referencegw_1x_payment_referencep_1x_statusCAPTUREDx_created2026-08-04T08:00:00.000Z";
    const signature = createHmac("sha256", "sk_test").update(signed, "utf8").digest("hex");
    expect(isValidTapWebhookSignature({ payload: charge, signature, secretApiKey: "sk_test" })).toBe(true);
    expect(isValidTapWebhookSignature({ payload: charge, signature: "0".repeat(64), secretApiKey: "sk_test" })).toBe(false);
  });

  it("records a duplicate webhook locally without calling Tap", async () => {
    const repository = { recordWebhookEvent: vi.fn().mockResolvedValue({ id: "event-row", isNew: false }), markEventCompleted: vi.fn(), failEvent: vi.fn(), persistCharge: vi.fn(), persistRefund: vi.fn() };
    await expect(processTapWebhook({ payload: charge, productReferenceMetadataKey: "product_id", repository })).resolves.toEqual({ processed: 0, duplicates: 1, ignored: 0 });
    expect(repository.persistCharge).not.toHaveBeenCalled();
  });

  it("uses a 48-hour Tap read window and records individual source errors", async () => {
    const repository = { startSyncRun: vi.fn().mockResolvedValue({ id: "run-1" }), completeSyncRun: vi.fn(), failSyncRun: vi.fn(), recordSyncError: vi.fn(), persistCharge: vi.fn().mockResolvedValue({ inserted: true }), persistRefund: vi.fn().mockResolvedValue({ inserted: true }) };
    const source = { fetchCharge: vi.fn().mockResolvedValue(charge), listChargesCreatedSince: vi.fn().mockResolvedValue([charge, { ...charge, id: "bad", currency: "BHD" }]), listRefundsCreatedSince: vi.fn().mockResolvedValue([refund]) };
    const result = await runTapReconciliation({ source, productReferenceMetadataKey: "product_id", repository, now: new Date("2026-08-05T12:00:00.000Z") });
    expect(source.listChargesCreatedSince).toHaveBeenCalledWith(new Date("2026-08-03T12:00:00.000Z"));
    expect(result).toMatchObject({ processed: 2, failed: 1, inserted: 2 });
  });

  it("imports charge then refund history in resumable pages", async () => {
    const repository = {
      persistCharge: vi.fn().mockResolvedValue({ inserted: true }), persistRefund: vi.fn().mockResolvedValue({ inserted: true }),
      getOrStartHistoricalBackfill: vi.fn().mockResolvedValueOnce({ id: "history", continuationCursor: null, recordsProcessed: 0, recordsFailed: 0, completed: false }).mockResolvedValueOnce({ id: "history", continuationCursor: "refunds:", recordsProcessed: 1, recordsFailed: 0, completed: false }),
      finishHistoricalBackfillBatch: vi.fn().mockResolvedValueOnce({ id: "history", recordsProcessed: 1, recordsFailed: 0, completed: false }).mockResolvedValueOnce({ id: "history", recordsProcessed: 2, recordsFailed: 0, completed: true }), failSyncRun: vi.fn(), recordSyncError: vi.fn(),
    };
    const source = { fetchCharge: vi.fn().mockResolvedValue(charge), listChargesPage: vi.fn().mockResolvedValue({ records: [charge], nextCursor: null }), listRefundsPage: vi.fn().mockResolvedValue({ records: [refund], nextCursor: null }) };
    expect(await runTapHistoricalBackfillBatch({ source, productReferenceMetadataKey: "product_id", repository })).toMatchObject({ hasMore: true, totalProcessed: 1 });
    expect(await runTapHistoricalBackfillBatch({ source, productReferenceMetadataKey: "product_id", repository })).toMatchObject({ hasMore: false, totalProcessed: 2 });
  });
});
