import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normaliseHubSpotDeal } from "@/lib/integrations/hubspot/normalise";
import { isValidHubSpotSignature } from "@/lib/integrations/hubspot/signature";
import { processHubSpotWebhook, runHubSpotReconciliation } from "@/server/services/sync-hubspot";

const mapping = {
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
    const deal = normaliseHubSpotDeal(rawDeal, mapping, stageMap);
    expect(deal.stageCode).toBe("closed_won");
    expect(deal.pipelineAmountUsd).toBe("1500.25");
    expect(deal.hubspotCloseDate).toBe("2026-08-01");
    expect(deal.stageHistory).toHaveLength(2);
  });

  it("refuses unknown stages and non-USD amounts without an explicitly mapped FX rate", () => {
    expect(() => normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, dealstage: "unreviewed_stage" } }, mapping, stageMap)).toThrow("no approved PLAYBOOK stage mapping");
    expect(() => normaliseHubSpotDeal({ ...rawDeal, properties: { ...rawDeal.properties, hs_currency: "BHD" } }, mapping, stageMap)).toThrow("requires a valid configured exchange-rate property");
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
      config: { apiBaseUrl: "https://api.hubapi.com", privateAppToken: "test", fieldMapping: mapping, stageMap },
      repository,
    });
    expect(result).toEqual({ processed: 0, duplicates: 1, failed: 0 });
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
      config: { apiBaseUrl: "https://api.hubapi.com", privateAppToken: "test", fieldMapping: mapping, stageMap },
      repository,
      now,
    });
    expect(result.lookbackStart.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(source.searchDealsModifiedSince).toHaveBeenCalledWith(result.lookbackStart);
  });
});
