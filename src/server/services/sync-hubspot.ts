import { z } from "zod";
import {
  type HubSpotConfig,
} from "@/lib/integrations/hubspot/config";
import {
  HubSpotNonB2bDealError,
  normaliseHubSpotDeal,
} from "@/lib/integrations/hubspot/normalise";
import type { HubSpotDealWithCompany } from "@/lib/integrations/hubspot/client";
import type { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";

const webhookEventSchema = z.object({
  eventId: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  subscriptionType: z.string().min(1),
  objectId: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
}).passthrough();

const webhookPayloadSchema = z.union([webhookEventSchema, z.array(webhookEventSchema).min(1)])
  .transform((payload) => Array.isArray(payload) ? payload : [payload]);

export type HubSpotWebhookEvent = z.infer<typeof webhookEventSchema>;

export type HubSpotSource = {
  fetchDealWithCompany(dealId: string): Promise<HubSpotDealWithCompany>;
  searchDealsModifiedSince(since: Date): Promise<HubSpotDealWithCompany[]>;
};

type HubSpotPersistenceRepository = Pick<SupabaseHubSpotSyncRepository, "persistDeal">;

type HubSpotWebhookRepository = HubSpotPersistenceRepository & Pick<
  SupabaseHubSpotSyncRepository,
  "recordWebhookEvent" | "markEventCompleted" | "failEvent"
>;

type HubSpotReconciliationRepository = HubSpotPersistenceRepository & Pick<
  SupabaseHubSpotSyncRepository,
  "startSyncRun" | "completeSyncRun" | "failSyncRun" | "recordSyncError"
>;

export function parseHubSpotWebhookPayload(payload: unknown): HubSpotWebhookEvent[] {
  return webhookPayloadSchema.parse(payload);
}

function isDealEvent(event: HubSpotWebhookEvent): boolean {
  return event.subscriptionType.toLowerCase().startsWith("deal.");
}

async function persistRemoteDeal(
  remote: HubSpotDealWithCompany,
  config: HubSpotConfig,
  repository: HubSpotPersistenceRepository,
): Promise<void> {
  const deal = normaliseHubSpotDeal(remote.deal, config.fieldMapping, config.stageMap, config.b2bPipelineId, config.companyCurrency);
  await repository.persistDeal({
    ...deal,
    company: {
      externalCompanyId: remote.company.id,
      legalName: remote.company.legalName,
      domain: remote.company.domain,
    },
    ownerName: remote.ownerName,
  });
}

/** Processes verified webhook events. Duplicate HubSpot event IDs are ignored safely. */
export async function processHubSpotWebhook(input: {
  events: HubSpotWebhookEvent[];
  source: HubSpotSource;
  config: HubSpotConfig;
  repository: HubSpotWebhookRepository;
}): Promise<{ processed: number; duplicates: number; ignored: number; failed: number }> {
  const result = { processed: 0, duplicates: 0, ignored: 0, failed: 0 };
  for (const event of input.events) {
    if (!isDealEvent(event)) continue;
    const recorded = await input.repository.recordWebhookEvent(event.eventId, event.subscriptionType);
    if (!recorded.isNew) {
      result.duplicates += 1;
      continue;
    }
    try {
      const remote = await input.source.fetchDealWithCompany(event.objectId);
      await persistRemoteDeal(remote, input.config, input.repository);
      await input.repository.markEventCompleted(recorded.id);
      result.processed += 1;
    } catch (error) {
      if (error instanceof HubSpotNonB2bDealError) {
        await input.repository.markEventCompleted(recorded.id);
        result.ignored += 1;
        continue;
      }
      await input.repository.failEvent(recorded.id, error);
      result.failed += 1;
    }
  }
  return result;
}

/** Re-fetches the required 48-hour window; source identity makes repeated runs idempotent. */
export async function runHubSpotReconciliation(input: {
  source: HubSpotSource;
  config: HubSpotConfig;
  repository: HubSpotReconciliationRepository;
  now?: Date;
}): Promise<{ processed: number; failed: number; lookbackStart: Date; lookbackEnd: Date }> {
  const lookbackEnd = input.now ?? new Date();
  const lookbackStart = new Date(lookbackEnd.getTime() - 48 * 60 * 60 * 1000);
  const syncRun = await input.repository.startSyncRun(lookbackStart, lookbackEnd);
  let processed = 0;
  let failed = 0;

  try {
    const deals = await input.source.searchDealsModifiedSince(lookbackStart);
    for (const remote of deals) {
      try {
        await persistRemoteDeal(remote, input.config, input.repository);
        processed += 1;
      } catch (error) {
        await input.repository.recordSyncError(syncRun.id, error);
        failed += 1;
      }
    }
    await input.repository.completeSyncRun(syncRun.id);
    return { processed, failed, lookbackStart, lookbackEnd };
  } catch (error) {
    await input.repository.failSyncRun(syncRun.id, error);
    throw error;
  }
}
