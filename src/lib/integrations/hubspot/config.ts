import { z } from "zod";

const stageCode = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const stageMapSchema = z.record(z.string().min(1), stageCode);

export type HubSpotFieldMapping = {
  pipeline: string;
  dealName: string;
  amount: string;
  currency: string;
  stage: string;
  closeDate: string;
  renewalDate?: string;
  ownerId?: string;
  lastModifiedAt?: string;
  exchangeRateToUsd?: string;
};

export type HubSpotConfig = {
  apiBaseUrl: string;
  privateAppToken: string;
  b2bPipelineId: string;
  companyCurrency: string;
  webhookClientSecret?: string;
  webhookCallbackUrl?: string;
  fieldMapping: HubSpotFieldMapping;
  stageMap: Record<string, string>;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for HubSpot sync.`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

/**
 * Provider field names and stage translations are configuration, not code.
 * This prevents an unverified HubSpot pipeline from silently changing financial totals.
 */
export function getHubSpotConfig(env: NodeJS.ProcessEnv = process.env): HubSpotConfig {
  let parsedStageMap: Record<string, string>;
  try {
    parsedStageMap = stageMapSchema.parse(JSON.parse(required(env, "HUBSPOT_STAGE_MAP_JSON")));
  } catch {
    throw new Error("HUBSPOT_STAGE_MAP_JSON must be a JSON object mapping HubSpot stage IDs to PLAYBOOK stage codes.");
  }

  return {
    apiBaseUrl: optional(env, "HUBSPOT_API_BASE_URL") ?? "https://api.hubapi.com",
    privateAppToken: required(env, "HUBSPOT_PRIVATE_APP_TOKEN"),
    b2bPipelineId: required(env, "HUBSPOT_B2B_PIPELINE_ID"),
    companyCurrency: required(env, "HUBSPOT_COMPANY_CURRENCY").toUpperCase(),
    webhookClientSecret: optional(env, "HUBSPOT_WEBHOOK_CLIENT_SECRET"),
    webhookCallbackUrl: optional(env, "HUBSPOT_WEBHOOK_CALLBACK_URL"),
    fieldMapping: {
      dealName: optional(env, "HUBSPOT_DEAL_NAME_PROPERTY") ?? "dealname",
      pipeline: optional(env, "HUBSPOT_PIPELINE_PROPERTY") ?? "pipeline",
      amount: optional(env, "HUBSPOT_AMOUNT_PROPERTY") ?? "amount",
      currency: optional(env, "HUBSPOT_CURRENCY_PROPERTY") ?? "deal_currency_code",
      stage: optional(env, "HUBSPOT_STAGE_PROPERTY") ?? "dealstage",
      closeDate: optional(env, "HUBSPOT_CLOSE_DATE_PROPERTY") ?? "closedate",
      renewalDate: optional(env, "HUBSPOT_RENEWAL_DATE_PROPERTY"),
      ownerId: optional(env, "HUBSPOT_OWNER_ID_PROPERTY") ?? "hubspot_owner_id",
      lastModifiedAt: optional(env, "HUBSPOT_LAST_MODIFIED_PROPERTY") ?? "hs_lastmodifieddate",
      exchangeRateToUsd: optional(env, "HUBSPOT_EXCHANGE_RATE_TO_USD_PROPERTY") ?? "hs_exchange_rate",
    },
    stageMap: parsedStageMap,
  };
}

export function requestedHubSpotDealProperties(mapping: HubSpotFieldMapping): string[] {
  return [...new Set([
    mapping.pipeline,
    mapping.dealName,
    mapping.amount,
    mapping.currency,
    mapping.stage,
    mapping.closeDate,
    mapping.renewalDate,
    mapping.ownerId,
    mapping.lastModifiedAt,
    mapping.exchangeRateToUsd,
  ].filter((property): property is string => Boolean(property)))];
}
