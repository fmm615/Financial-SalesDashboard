import { z } from "zod";
import type { HubSpotFieldMapping } from "@/lib/integrations/hubspot/config";

const decimal = /^\d+(?:\.\d+)?$/;
const hubSpotDealSchema = z.object({
  id: z.string().min(1),
  properties: z.record(z.string(), z.string().nullable()).default({}),
}).passthrough();

export type HubSpotDeal = z.infer<typeof hubSpotDealSchema>;

export type NormalisedHubSpotDeal = {
  externalDealId: string;
  name: string;
  stageCode: string;
  pipelineOriginalAmount: string;
  originalCurrency: string;
  exchangeRateToUsd: string;
  pipelineAmountUsd: string;
  hubspotCloseDate: string | null;
  renewalDate: string | null;
  ownerId: string | null;
  lastModifiedAt: string | null;
  sourceMetadata: Record<string, string>;
  stageHistory: Array<{ stageCode: string; changedAt: string; externalEventId: string | null }>;
};

function property(properties: Record<string, string | null>, name: string, label: string): string {
  const value = properties[name]?.trim();
  if (!value) throw new Error(`HubSpot deal is missing ${label} (${name}).`);
  return value;
}

function optionalProperty(properties: Record<string, string | null>, name?: string): string | null {
  const value = name ? properties[name]?.trim() : undefined;
  return value || null;
}

function parseDate(value: string, label: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const milliseconds = /^\d{10,}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`HubSpot ${label} is not a valid date.`);
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function multiplyDecimalStrings(left: string, right: string): string {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const leftInt = BigInt(`${leftWhole}${leftFraction}`);
  const rightInt = BigInt(`${rightWhole}${rightFraction}`);
  const scale = leftFraction.length + rightFraction.length;
  if (scale === 0) return (leftInt * rightInt).toString();
  const product = (leftInt * rightInt).toString().padStart(scale + 1, "0");
  const whole = product.slice(0, -scale) || "0";
  const fraction = product.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function normaliseStageHistory(
  raw: HubSpotDeal,
  mapping: HubSpotFieldMapping,
  stageMap: Record<string, string>,
): Array<{ stageCode: string; changedAt: string; externalEventId: string | null }> {
  const history = (raw as { propertiesWithHistory?: Record<string, unknown> }).propertiesWithHistory?.[mapping.stage];
  if (!Array.isArray(history)) return [];

  return history.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("HubSpot stage history contains an invalid entry.");
    const value = (entry as { value?: unknown }).value;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    if (typeof value !== "string" || typeof timestamp !== "string") {
      throw new Error("HubSpot stage history requires a stage value and timestamp.");
    }
    const stageCode = stageMap[value];
    if (!stageCode) throw new Error(`HubSpot historic stage '${value}' has no approved PLAYBOOK stage mapping.`);
    const eventId = (entry as { sourceId?: unknown }).sourceId;
    const parsedTimestamp = Date.parse(timestamp);
    if (!Number.isFinite(parsedTimestamp)) throw new Error("HubSpot stage history timestamp is invalid.");
    return {
      stageCode,
      changedAt: new Date(parsedTimestamp).toISOString(),
      externalEventId: typeof eventId === "string" && eventId ? eventId : null,
    };
  });
}

/** Maps a HubSpot record to the internal B2B contract without using floating point. */
export function normaliseHubSpotDeal(
  raw: unknown,
  mapping: HubSpotFieldMapping,
  stageMap: Record<string, string>,
): NormalisedHubSpotDeal {
  const deal = hubSpotDealSchema.parse(raw);
  const name = property(deal.properties, mapping.dealName, "deal name");
  const amount = property(deal.properties, mapping.amount, "amount");
  if (!decimal.test(amount)) throw new Error("HubSpot deal amount must be a non-negative decimal.");

  const hubSpotStage = property(deal.properties, mapping.stage, "stage");
  const stageCode = stageMap[hubSpotStage];
  if (!stageCode) throw new Error(`HubSpot stage '${hubSpotStage}' has no approved PLAYBOOK stage mapping.`);

  const currency = property(deal.properties, mapping.currency, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("HubSpot deal currency must be an ISO 4217 code.");

  const configuredFxRate = optionalProperty(deal.properties, mapping.exchangeRateToUsd);
  const exchangeRateToUsd = currency === "USD" ? "1" : configuredFxRate;
  if (!exchangeRateToUsd || !decimal.test(exchangeRateToUsd) || exchangeRateToUsd === "0") {
    throw new Error("A non-USD HubSpot deal requires a valid configured exchange-rate property.");
  }

  const closeDateValue = optionalProperty(deal.properties, mapping.closeDate);
  const hubspotCloseDate = closeDateValue ? parseDate(closeDateValue, "close date") : null;
  const renewalDateValue = optionalProperty(deal.properties, mapping.renewalDate);
  const renewalDate = renewalDateValue ? parseDate(renewalDateValue, "renewal date") : null;

  if (stageCode === "closed_won" && !hubspotCloseDate) {
    throw new Error("A closed-won HubSpot deal requires a close date before a booking can be recorded.");
  }

  const ownerId = optionalProperty(deal.properties, mapping.ownerId);
  const lastModifiedAt = optionalProperty(deal.properties, mapping.lastModifiedAt);
  return {
    externalDealId: deal.id,
    name,
    stageCode,
    pipelineOriginalAmount: amount,
    originalCurrency: currency,
    exchangeRateToUsd,
    pipelineAmountUsd: multiplyDecimalStrings(amount, exchangeRateToUsd),
    hubspotCloseDate,
    renewalDate,
    ownerId,
    lastModifiedAt,
    sourceMetadata: {
      hubspot_stage: hubSpotStage,
      ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
      ...(lastModifiedAt ? { hubspot_last_modified_at: lastModifiedAt } : {}),
    },
    stageHistory: normaliseStageHistory(deal, mapping, stageMap),
  };
}
