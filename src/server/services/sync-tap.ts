import { normaliseTapCharge, normaliseTapRefund, TapRefundNotSucceededError } from "@/lib/integrations/tap/normalise";
import type { ProviderBackfillRun, SupabaseTapSyncRepository } from "@/server/repositories/stripe-sync-repository";

export type TapSource = {
  fetchCharge(chargeId: string): Promise<unknown>;
  listChargesCreatedSince(since: Date): Promise<unknown[]>;
  listRefundsCreatedSince(since: Date): Promise<unknown[]>;
};

export type TapHistoricalSource = Pick<TapSource, "fetchCharge"> & {
  listChargesPage(cursor?: string): Promise<{ records: unknown[]; nextCursor: string | null }>;
  listRefundsPage(cursor?: string): Promise<{ records: unknown[]; nextCursor: string | null }>;
};

type TapRepository = Pick<SupabaseTapSyncRepository, "persistCharge" | "persistRefund">;
type TapReconciliationRepository = TapRepository & Pick<SupabaseTapSyncRepository, "startSyncRun" | "completeSyncRun" | "failSyncRun" | "recordSyncError">;
type TapBackfillRepository = TapRepository & Pick<SupabaseTapSyncRepository, "getOrStartHistoricalBackfill" | "finishHistoricalBackfillBatch" | "failSyncRun" | "recordSyncError">;
type TapWebhookRepository = TapRepository & Pick<SupabaseTapSyncRepository, "recordWebhookEvent" | "markEventCompleted" | "failEvent">;

function chargeReference(chargeId: string): string { return `Tap charge ${chargeId}`; }
function refundReference(refundId: string): string { return `Tap refund ${refundId}`; }

function sourceId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

async function persistCharge(input: {
  charge: unknown;
  productReferenceMetadataKey: string;
  repository: TapRepository;
  providerEventId?: string;
  reconciliationSource?: string;
}): Promise<boolean> {
  const charge = normaliseTapCharge(input.charge, input.productReferenceMetadataKey);
  return (await input.repository.persistCharge({
    ...charge,
    providerEventId: input.providerEventId,
    reconciliationSource: input.reconciliationSource,
  })).inserted;
}

async function persistRefund(input: {
  refund: unknown;
  source: Pick<TapSource, "fetchCharge">;
  productReferenceMetadataKey: string;
  repository: TapRepository;
}): Promise<boolean> {
  const refund = normaliseTapRefund(input.refund);
  // A refund can arrive before the corresponding charge. Read the source
  // charge first so the local source ledger always retains the linkage.
  await persistCharge({
    charge: await input.source.fetchCharge(refund.chargeId),
    productReferenceMetadataKey: input.productReferenceMetadataKey,
    repository: input.repository,
  });
  return (await input.repository.persistRefund(refund)).inserted;
}

/** Processes a signature-verified Tap charge post without calling Tap back. */
export async function processTapWebhook(input: {
  payload: unknown;
  productReferenceMetadataKey: string;
  repository: TapWebhookRepository;
}): Promise<{ processed: number; duplicates: number; ignored: number }> {
  const id = sourceId(input.payload);
  if (!id) throw new Error("Tap webhook is missing its charge ID.");
  const status = typeof (input.payload as { status?: unknown }).status === "string" ? (input.payload as { status: string }).status : "unknown";
  const eventId = `charge:${id}:${status}`;
  const recorded = await input.repository.recordWebhookEvent(eventId, `tap.charge.${status.toLowerCase()}`);
  if (!recorded.isNew) return { processed: 0, duplicates: 1, ignored: 0 };
  try {
    await persistCharge({ charge: input.payload, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, providerEventId: eventId });
    await input.repository.markEventCompleted(recorded.id);
    return { processed: 1, duplicates: 0, ignored: 0 };
  } catch (error) {
    await input.repository.failEvent(recorded.id, error, chargeReference(id));
    throw error;
  }
}

/** Re-reads Tap's last 48 hours. Provider IDs and content checks prevent double counting. */
export async function runTapReconciliation(input: {
  source: TapSource;
  productReferenceMetadataKey: string;
  repository: TapReconciliationRepository;
  now?: Date;
}): Promise<{ processed: number; failed: number; inserted: number; lookbackStart: Date; lookbackEnd: Date }> {
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
        if (await persistCharge({ charge, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, reconciliationSource: "tap_48_hour_reconciliation" })) inserted += 1;
        processed += 1;
      } catch (error) {
        await input.repository.recordSyncError(run.id, error, chargeReference(sourceId(charge) ?? "unknown"));
        failed += 1;
      }
    }
    for (const refund of refunds) {
      try {
        if (await persistRefund({ refund, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository })) inserted += 1;
        processed += 1;
      } catch (error) {
        if (error instanceof TapRefundNotSucceededError) { processed += 1; continue; }
        await input.repository.recordSyncError(run.id, error, refundReference(sourceId(refund) ?? "unknown"));
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

/** Read-only, resumable all-history Tap import in pages of at most 50 records. */
export async function runTapHistoricalBackfillBatch(input: {
  source: TapHistoricalSource;
  productReferenceMetadataKey: string;
  repository: TapBackfillRepository;
  restartCompleted?: boolean;
}): Promise<{ runId: string; processed: number; failed: number; totalProcessed: number; totalFailed: number; hasMore: boolean }> {
  const run: ProviderBackfillRun = await input.repository.getOrStartHistoricalBackfill({ restartCompleted: input.restartCompleted });
  if (run.completed) return { runId: run.id, processed: 0, failed: 0, totalProcessed: run.recordsProcessed, totalFailed: run.recordsFailed, hasMore: false };

  let processed = 0;
  let failed = 0;
  try {
    const cursor = parseHistoricalCursor(run.continuationCursor);
    if (cursor.phase === "charges") {
      const page = await input.source.listChargesPage(cursor.providerCursor);
      for (const charge of page.records) {
        try {
          await persistCharge({ charge, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, reconciliationSource: "tap_historical_backfill" });
          processed += 1;
        } catch (error) {
          await input.repository.recordSyncError(run.id, error, chargeReference(sourceId(charge) ?? "unknown"));
          failed += 1;
        }
      }
      const saved = await input.repository.finishHistoricalBackfillBatch({ runId: run.id, processed, failed, nextCursor: page.nextCursor ? `charges:${page.nextCursor}` : "refunds:" });
      return { runId: saved.id, processed, failed, totalProcessed: saved.recordsProcessed, totalFailed: saved.recordsFailed, hasMore: true };
    }

    const page = await input.source.listRefundsPage(cursor.providerCursor);
    for (const refund of page.records) {
      try {
        await persistRefund({ refund, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository });
        processed += 1;
      } catch (error) {
        if (error instanceof TapRefundNotSucceededError) { processed += 1; continue; }
        await input.repository.recordSyncError(run.id, error, refundReference(sourceId(refund) ?? "unknown"));
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
