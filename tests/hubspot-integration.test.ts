import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normaliseHubSpotDeal } from "@/lib/integrations/hubspot/normalise";
import { isValidHubSpotSignature } from "@/lib/integrations/hubspot/signature";
import { hubSpotCloseDateCorrectionSchema, hubSpotDealCorrectionSchema, hubSpotDuplicateResolutionSchema, hubSpotErrorResolutionSchema } from "@/lib/validation/hubspot-review-contracts";
import { processHubSpotWebhook, runHubSpotHistoricalBackfillBatch, runHubSpotReconciliation } from "@/server/services/sync-hubspot";

const mapping = {
  pipeline: "pipeline",
  dealName: "dealname",
  amount: "amount",
  currency: "hs_currency",
  stage: "dealstage",
  closeDate: "closedate",
  renewalDate: "contract_end_date",
  ownerId: "hubspot_owner_id",
  lastModifiedAt: "hs_lastmodifieddate",
};

const stageMap = {
  prospecting: "discovery",
  qualification: "qualified",
  proposal: "proposal",
  negotiation: "negotiation",
  closedwon: "closed_won",
  closedlost: "closed_lost",
};

const rawDeal = {
  id: "123",
  properties: {
    dealname: "Acme annual membership",
    pipeline: "default",
    amount: "1500.25",
    hs_currency: "USD",
    dealstage: "closedwon",
    closedate: "2026-08-01",
    contract_end_date: "2027-08-01",
    hubspot_owner_id: "55",
    hs_lastmodifieddate: "2026-08-01T12:00:00.000Z",
  },
  propertiesWithHistory: {
    dealstage: [{ value: "prospecting", timestamp: "2026-07-01T12:00:00.000Z" }, { value: "closedwon", timestamp: "2026-08-01T12:00:00.000Z" }],
  },
};

describe("HubSpot normalisation", () => {
  it("maps an explicitly approved stage and creates a USD booking value without floating point", () => {
    const deal = normaliseHubSpotDeal(rawDeal, mapping, stageMap, "default", "USD");
    expect(deal.stageCode).toBe("closed_won");
    expect(deal.pipelineAmountUsd).toBe("1500.25");
    expect(deal.hubspotCloseDate).toBe("2026-08-01");
    expect(deal.stageHistory).toHaveLength(2);
  });

  it("refuses unknown stages and non-USD amounts without an explicitly mapped FX rate", () => {
    expect(() => normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, dealstage: "unreviewed_stage" } }, mapping, stageMap, "default", "USD")).toThrow("no approved PLAYBOOK stage mapping");
    expect(() => normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, hs_currency: "BHD" } }, mapping, stageMap, "default", "USD")).toThrow("requires a valid configured exchange rate");
    expect(() => normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, pipeline: "177536731" } }, mapping, stageMap, "default", "USD")).toThrow("non-B2B pipeline");
  });

  it("retains a deal with a missing amount for review without assigning it a financial value", () => {
    const deal = normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, amount: null } }, mapping, stageMap, "default", "USD");
    expect(deal.financialStatus).toBe("needs_review");
    expect(deal.pipelineOriginalAmount).toBeNull();
    expect(deal.exchangeRateToUsd).toBeNull();
    expect(deal.pipelineAmountUsd).toBeNull();
  });

  it("retains a deal with a missing currency for review without inventing an FX rate", () => {
    const deal = normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, hs_currency: null } }, mapping, stageMap, "default", "USD");
    expect(deal.financialStatus).toBe("needs_review");
    expect(deal.originalCurrency).toBeNull();
    expect(deal.exchangeRateToUsd).toBeNull();
  });

  it("retains known financial values when a closed-won deal only lacks its booking date", () => {
    const deal = normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, closedate: null } }, mapping, stageMap, "default", "USD");
    expect(deal.financialStatus).toBe("complete");
    expect(deal.pipelineAmountUsd).toBe("1500.25");
    expect(deal.hubspotCloseDate).toBeNull();
  });
});

describe("HubSpot webhook security", () => {
  it("accepts only a current v3 signature over the untouched payload", () => {
    const now = 1_754_000_000_000;
    const secret = "test-client-secret";
    const url = "https://dashboard.example.com/api/webhooks/hubspot";
    const body = '[{"eventId":1}]';
    const timestamp = String(now - 1_000);
    const signature = createHmac("sha256", secret).update(`POST${url}${body}${timestamp}`, "utf8").digest("base64");
    expect(isValidHubSpotSignature({ clientSecret: secret, method: "POST", url, body, timestamp, signature, now })).toBe(true);
    expect(isValidHubSpotSignature({ clientSecret: secret, method: "POST", url, body, timestamp: String(now - 300_001), signature, now })).toBe(false);
  });
});

describe("HubSpot ingestion orchestration", () => {
  it("skips a duplicated webhook event and does not create recognised sales", async () => {
    const repository = {
      recordWebhookEvent: vi.fn().mockResolvedValue({ id: "event-row", isNew: false }),
      markEventCompleted: vi.fn(),
      failEvent: vi.fn(),
      persistDeal: vi.fn(),
    };
    const source = { fetchDealWithCompany: vi.fn(), searchDealsModifiedSince: vi.fn() };
    const result = await processHubSpotWebhook({
      events: [{ eventId: "99", subscriptionType: "deal.propertyChange", objectId: "123" }],
      source,
      config: { apiBaseUrl: "https://api.hubapi.com", privateAppToken: "test", b2bPipelineId: "default", companyCurrency: "USD", fieldMapping: mapping, stageMap },
      repository,
    });
    expect(result).toEqual({ processed: 0, duplicates: 1, ignored: 0, failed: 0 });
    expect(source.fetchDealWithCompany).not.toHaveBeenCalled();
    expect(repository.persistDeal).not.toHaveBeenCalled();
  });

  it("uses exactly the required 48-hour reconciliation window", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const repository = {
      startSyncRun: vi.fn().mockResolvedValue({ id: "run-1" }),
      completeSyncRun: vi.fn(),
      failSyncRun: vi.fn(),
      recordSyncError: vi.fn(),
      persistDeal: vi.fn(),
    };
    const source = { fetchDealWithCompany: vi.fn(), searchDealsModifiedSince: vi.fn().mockResolvedValue([]) };
    const result = await runHubSpotReconciliation({
      source,
      config: { apiBaseUrl: "https://api.hubapi.com", privateAppToken: "test", b2bPipelineId: "default", companyCurrency: "USD", fieldMapping: mapping, stageMap },
      repository,
      now,
    });
    expect(result.lookbackStart.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(source.searchDealsModifiedSince).toHaveBeenCalledWith(result.lookbackStart);
  });

  it("records a safe exact HubSpot deal reference when one source deal fails", async () => {
    const repository = {
      startSyncRun: vi.fn().mockResolvedValue({ id: "run-1" }),
      completeSyncRun: vi.fn(),
      failSyncRun: vi.fn(),
      recordSyncError: vi.fn(),
      persistDeal: vi.fn(),
    };
    const incompleteWonDeal = { ...rawDeal, properties: { ...rawDeal.properties, dealstage: "unreviewed_stage" } };
    const source = {
      fetchDealWithCompany: vi.fn(),
      searchDealsModifiedSince: vi.fn().mockResolvedValue([{ deal: incompleteWonDeal, company: { id: "company-1", legalName: "Acme", domain: null }, ownerName: null }]),
    };
    await runHubSpotReconciliation({
      source,
      config: { apiBaseUrl: "https://api.hubapi.com", privateAppToken: "test", b2bPipelineId: "default", companyCurrency: "USD", fieldMapping: mapping, stageMap },
      repository,
      now: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(repository.recordSyncError).toHaveBeenCalledWith("run-1", expect.any(Error), "HubSpot deal 123 — Acme annual membership");
  });

  it("processes one persisted page of the approved B2B backfill at a time", async () => {
    const repository = {
      getOrStartHistoricalBackfill: vi.fn().mockResolvedValue({ id: "backfill-1", continuationCursor: null, recordsProcessed: 20, recordsFailed: 1, completed: false }),
      finishHistoricalBackfillBatch: vi.fn().mockResolvedValue({ id: "backfill-1", continuationCursor: "next", recordsProcessed: 21, recordsFailed: 1, completed: false }),
      recordSyncError: vi.fn(),
      failSyncRun: vi.fn(),
      persistDeal: vi.fn(),
    };
    const source = { fetchDealWithCompany: vi.fn(), searchAllB2bDealsPage: vi.fn().mockResolvedValue({ deals: [{ deal: rawDeal, company: { id: "company-1", legalName: "Acme", domain: null }, ownerName: null }], nextCursor: "next" }) };
    const result = await runHubSpotHistoricalBackfillBatch({
      source,
      config: { apiBaseUrl: "https://api.hubapi.com", privateAppToken: "test", b2bPipelineId: "default", companyCurrency: "USD", fieldMapping: mapping, stageMap },
      repository,
    });
    expect(source.searchAllB2bDealsPage).toHaveBeenCalledWith(undefined);
    expect(repository.getOrStartHistoricalBackfill).toHaveBeenCalledWith({ restartCompleted: undefined });
    expect(repository.persistDeal).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ runId: "backfill-1", processed: 1, totalProcessed: 21, hasMore: true });
  });
});

describe("HubSpot Admin review contracts", () => {
  it("requires a complete local financial correction and an audit reason", () => {
    expect(hubSpotDealCorrectionSchema.safeParse({ amount: "1500", currency: "usd", exchangeRateToUsd: "1", reason: "Approved Finance correction" }).success).toBe(true);
    expect(hubSpotDealCorrectionSchema.safeParse({ amount: "1500", currency: "USD", exchangeRateToUsd: "0", reason: "Approved Finance correction" }).success).toBe(false);
    expect(hubSpotDealCorrectionSchema.safeParse({ amount: "1500", currency: "USD", exchangeRateToUsd: "1", reason: "" }).success).toBe(false);
    expect(hubSpotErrorResolutionSchema.safeParse({ resolutionNote: "" }).success).toBe(false);
    expect(hubSpotDuplicateResolutionSchema.safeParse({ decision: "keep_one", keepDealId: null, resolutionNote: "Approved after checking HubSpot" }).success).toBe(false);
    expect(hubSpotDuplicateResolutionSchema.safeParse({ decision: "keep_both", keepDealId: null, resolutionNote: "Separate signed agreements" }).success).toBe(true);
    expect(hubSpotCloseDateCorrectionSchema.safeParse({ closeDate: "2026-08-02", reason: "Signed agreement confirms the date" }).success).toBe(true);
    expect(hubSpotCloseDateCorrectionSchema.safeParse({ closeDate: "02/08/2026", reason: "Signed agreement confirms the date" }).success).toBe(false);
  });
});
