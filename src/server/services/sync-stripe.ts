import { normaliseStripeCharge, normaliseStripeRefund, parseStripeWebhookEvent, StripeRefundNotSucceededError, type StripeWebhookEvent } from "@/lib/integrations/stripe/normalise";
import type { StripeBackfillRun, SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";

export type StripeSource = {
  fetchCharge(chargeId: string): Promise<unknown>;
  listChargesCreatedSince(since: Date): Promise<unknown[]>;
  listRefundsCreatedSince(since: Date): Promise<unknown[]>;
};

export type StripeHistoricalSource = Pick<StripeSource, "fetchCharge"> & {
  listChargesPage(cursor?: string): Promise<{ records: unknown[]; nextCursor: string | null }>;
  listRefundsPage(cursor?: string): Promise<{ records: unknown[]; nextCursor: string | null }>;
};

type StripeRepository = Pick<SupabaseStripeSyncRepository, "persistCharge" | "persistRefund">;
type StripeWebhookRepository = StripeRepository & Pick<SupabaseStripeSyncRepository, "recordWebhookEvent" | "markEventCompleted" | "failEvent">;
type StripeReconciliationRepository = StripeRepository & Pick<SupabaseStripeSyncRepository, "startSyncRun" | "completeSyncRun" | "failSyncRun" | "recordSyncError">;
type StripeBackfillRepository = StripeRepository & Pick<SupabaseStripeSyncRepository, "getOrStartHistoricalBackfill" | "finishHistoricalBackfillBatch" | "failSyncRun" | "recordSyncError">;

function chargeReference(chargeId: string): string { return `Stripe charge ${chargeId}`; }
function refundReference(refundId: string): string { return `Stripe refund ${refundId}`; }

async function persistCharge(input: { charge: unknown; productReferenceMetadataKey: string; repository: StripeRepository; providerEventId?: string; reconciliationSource?: string }): Promise<boolean> {
  const charge = normaliseStripeCharge(input.charge, input.productReferenceMetadataKey);
  const result = await input.repository.persistCharge({ ...charge, providerEventId: input.providerEventId, reconciliationSource: input.reconciliationSource });
  return result.inserted;
}

async function persistRefund(input: { refund: unknown; source: Pick<StripeSource, "fetchCharge">; productReferenceMetadataKey: string; repository: StripeRepository }): Promise<boolean> {
  const refund = normaliseStripeRefund(input.refund);
  // A refund can arrive before the matching charge's webhook. Read the charge first
  // so the original B2C record always exists before its separate refund row.
  await persistCharge({ charge: await input.source.fetchCharge(refund.chargeId), productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository });
  const result = await input.repository.persistRefund(refund);
  return result.inserted;
}

/** Parses an already signature-verified Stripe event. */
export function parseStripeWebhookPayload(payload: unknown): StripeWebhookEvent { return parseStripeWebhookEvent(payload); }

/** Handles only known financial Stripe events. Unknown events are recorded then safely ignored. */
export async function processStripeWebhook(input: { event: StripeWebhookEvent; source: StripeSource; productReferenceMetadataKey: string; repository: StripeWebhookRepository }): Promise<{ processed: number; duplicates: number; ignored: number }> {
  const recorded = await input.repository.recordWebhookEvent(input.event.id, input.event.type);
  if (!recorded.isNew) return { processed: 0, duplicates: 1, ignored: 0 };
  try {
    if (input.event.type === "charge.succeeded" || input.event.type === "charge.failed") {
      await persistCharge({ charge: input.event.data.object, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, providerEventId: input.event.id });
      await input.repository.markEventCompleted(recorded.id);
      return { processed: 1, duplicates: 0, ignored: 0 };
    }
    if (input.event.type === "refund.created" || input.event.type === "refund.updated") {
      try {
        await persistRefund({ refund: input.event.data.object, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository });
      } catch (error) {
        // Stripe can send a refund.created event while the refund is still pending.
        // A later refund.updated event will carry the succeeded state. Pending/failed
        // refunds are not financial records and should not become false integration errors.
        if (!(error instanceof StripeRefundNotSucceededError)) throw error;
      }
      await input.repository.markEventCompleted(recorded.id);
      return { processed: 1, duplicates: 0, ignored: 0 };
    }
    await input.repository.markEventCompleted(recorded.id);
    return { processed: 0, duplicates: 0, ignored: 1 };
  } catch (error) {
    const object = input.event.data.object as { id?: unknown };
    const reference = typeof object.id === "string" ? (input.event.type === "refund.created" ? refundReference(object.id) : chargeReference(object.id)) : `Stripe event ${input.event.id}`;
    await input.repository.failEvent(recorded.id, error, reference);
    throw error;
  }
}

/** Re-fetches the mandatory 48-hour window. Provider IDs and content checks prevent double counting. */
export async function runStripeReconciliation(input: { source: StripeSource; productReferenceMetadataKey: string; repository: StripeReconciliationRepository; now?: Date }): Promise<{ processed: number; failed: number; inserted: number; lookbackStart: Date; lookbackEnd: Date }> {
  const lookbackEnd = input.now ?? new Date();
  const lookbackStart = new Date(lookbackEnd.getTime() - 48 * 60 * 60 * 1000);
  const run = await input.repository.startSyncRun(lookbackStart, lookbackEnd);
  let processed = 0;
  let failed = 0;
  let inserted = 0;
  try {
    const [charges, refunds] = await Promise.all([input.source.listChargesCreatedSince(lookbackStart), input.source.listRefundsCreatedSince(lookbackStart)]);
    for (const charge of charges) {
      try {
        if (await persistCharge({ charge, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, reconciliationSource: "stripe_48_hour_reconciliation" })) inserted += 1;
        processed += 1;
      } catch (error) {
        const id = (charge as { id?: unknown }).id;
        await input.repository.recordSyncError(run.id, error, typeof id === "string" ? chargeReference(id) : "Stripe charge");
        failed += 1;
      }
    }
    for (const refund of refunds) {
      try {
        if (await persistRefund({ refund, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository })) inserted += 1;
        processed += 1;
      } catch (error) {
        if (error instanceof StripeRefundNotSucceededError) {
          processed += 1;
          continue;
        }
        const id = (refund as { id?: unknown }).id;
        await input.repository.recordSyncError(run.id, error, typeof id === "string" ? refundReference(id) : "Stripe refund");
        failed += 1;
      }
    }
    await input.repository.completeSyncRun(run.id);
    return { processed, failed, inserted, lookbackStart, lookbackEnd };
  } catch (error) {
    await input.repository.failSyncRun(run.id, error);
    throw error;
  }
}

function parseHistoricalCursor(cursor: string | null): { phase: "charges" | "refunds"; providerCursor?: string } {
  if (cursor?.startsWith("refunds:")) return { phase: "refunds", providerCursor: cursor.slice("refunds:".length) || undefined };
  if (cursor?.startsWith("charges:")) return { phase: "charges", providerCursor: cursor.slice("charges:".length) || undefined };
  return { phase: "charges" };
}

/**
 * Imports the entire Stripe B2C history in persisted provider pages. This is
 * read-only against Stripe and safe to resume: exact provider IDs make every
 * charge/refund persistence operation idempotent.
 */
export async function runStripeHistoricalBackfillBatch(input: {
  source: StripeHistoricalSource;
  productReferenceMetadataKey: string;
  repository: StripeBackfillRepository;
  restartCompleted?: boolean;
}): Promise<{ runId: string; processed: number; failed: number; totalProcessed: number; totalFailed: number; hasMore: boolean }> {
  const run: StripeBackfillRun = await input.repository.getOrStartHistoricalBackfill({ restartCompleted: input.restartCompleted });
  if (run.completed) return { runId: run.id, processed: 0, failed: 0, totalProcessed: run.recordsProcessed, totalFailed: run.recordsFailed, hasMore: false };

  let processed = 0;
  let failed = 0;
  try {
    const cursor = parseHistoricalCursor(run.continuationCursor);
    if (cursor.phase === "charges") {
      const page = await input.source.listChargesPage(cursor.providerCursor);
      for (const charge of page.records) {
        try {
          await persistCharge({ charge, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, reconciliationSource: "stripe_historical_backfill" });
          processed += 1;
        } catch (error) {
          const id = (charge as { id?: unknown }).id;
          await input.repository.recordSyncError(run.id, error, typeof id === "string" ? chargeReference(id) : "Stripe charge");
          failed += 1;
        }
      }
      const nextCursor = page.nextCursor ? `charges:${page.nextCursor}` : "refunds:";
      const saved = await input.repository.finishHistoricalBackfillBatch({ runId: run.id, processed, failed, nextCursor });
      return { runId: saved.id, processed, failed, totalProcessed: saved.recordsProcessed, totalFailed: saved.recordsFailed, hasMore: true };
    }

    const page = await input.source.listRefundsPage(cursor.providerCursor);
    for (const refund of page.records) {
      try {
        await persistRefund({ refund, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository });
        processed += 1;
      } catch (error) {
        if (error instanceof StripeRefundNotSucceededError) {
          processed += 1;
          continue;
        }
        const id = (refund as { id?: unknown }).id;
        await input.repository.recordSyncError(run.id, error, typeof id === "string" ? refundReference(id) : "Stripe refund");
        failed += 1;
      }
    }
    const saved = await input.repository.finishHistoricalBackfillBatch({ runId: run.id, processed, failed, nextCursor: page.nextCursor ? `refunds:${page.nextCursor}` : null });
    return { runId: saved.id, processed, failed, totalProcessed: saved.recordsProcessed, totalFailed: saved.recordsFailed, hasMore: !saved.completed };
  } catch (error) {
    await input.repository.failSyncRun(run.id, error);
    throw error;
  }
}
