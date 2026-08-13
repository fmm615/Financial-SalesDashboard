import { addStripeCheckoutPlan, normaliseStripeCharge, normaliseStripeCheckoutPlan, normaliseStripeRefund, parseStripeWebhookEvent, StripeRefundNotSucceededError, type StripeWebhookEvent } from "@/lib/integrations/stripe/normalise";
import { applyStripeTransactionEnrichment, normaliseStripeEnrichment, normaliseStripeRefundSettlement, stripeChargeEnrichmentReferences, type NormalisedStripeEnrichment } from "@/lib/integrations/stripe/enrichment";
import type { StripeBackfillRun, SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";

export type StripeSource = {
  fetchCharge(chargeId: string): Promise<unknown>;
  fetchCheckoutPlanForPaymentIntent?(paymentIntentId: string): Promise<unknown | null>;
  fetchCheckoutContextForPaymentIntent?(paymentIntentId: string): Promise<unknown | null>;
  fetchInvoice?(invoiceId: string): Promise<unknown>;
  fetchPaymentMethod?(paymentMethodId: string): Promise<unknown>;
  fetchCustomer?(customerId: string): Promise<unknown>;
  fetchBalanceTransaction?(balanceTransactionId: string): Promise<unknown>;
  listChargesCreatedSince(since: Date): Promise<unknown[]>;
  listRefundsCreatedSince(since: Date): Promise<unknown[]>;
};

export type StripeHistoricalSource = Pick<StripeSource, "fetchCharge" | "fetchBalanceTransaction"> & {
  listChargesPage(cursor?: string): Promise<{ records: unknown[]; nextCursor: string | null }>;
  listRefundsPage(cursor?: string): Promise<{ records: unknown[]; nextCursor: string | null }>;
};

type StripeRepository = Pick<SupabaseStripeSyncRepository, "persistCharge" | "persistRefund"> & Partial<Pick<SupabaseStripeSyncRepository, "persistStripeDetails" | "persistStripeRefundDetails" | "recordOptionalEnrichmentError">>;
type StripeWebhookRepository = StripeRepository & Pick<SupabaseStripeSyncRepository, "recordWebhookEvent" | "markEventCompleted" | "failEvent">;
type StripeReconciliationRepository = StripeRepository & Pick<SupabaseStripeSyncRepository, "startSyncRun" | "completeSyncRun" | "failSyncRun" | "recordSyncError">;
type StripeBackfillRepository = StripeRepository & Pick<SupabaseStripeSyncRepository, "getOrStartHistoricalBackfill" | "finishHistoricalBackfillBatch" | "failSyncRun" | "recordSyncError">;

function chargeReference(chargeId: string): string { return `Stripe charge ${chargeId}`; }
function refundReference(refundId: string): string { return `Stripe refund ${refundId}`; }

type StripePlanLookupSource = { fetchCheckoutPlanForPaymentIntent?: (paymentIntentId: string) => Promise<unknown | null> };

type OptionalObjectType = "checkout_session" | "invoice" | "payment_method" | "customer" | "balance_transaction";

async function collectStripeEnrichment(input: { rawCharge: unknown; charge: ReturnType<typeof normaliseStripeCharge>; source: StripeSource; repository: StripeRepository; integrationEventId?: string; syncRunId?: string }): Promise<NormalisedStripeEnrichment> {
  const references = stripeChargeEnrichmentReferences(input.rawCharge);
  const lookups: Array<{ objectType: OptionalObjectType; run: () => Promise<unknown | null> }> = [];
  if (references.paymentIntentId && input.source.fetchCheckoutContextForPaymentIntent) lookups.push({ objectType: "checkout_session", run: () => input.source.fetchCheckoutContextForPaymentIntent!(references.paymentIntentId!) });
  if (references.invoiceId && input.source.fetchInvoice) lookups.push({ objectType: "invoice", run: () => input.source.fetchInvoice!(references.invoiceId!) });
  if (references.paymentMethodId && input.source.fetchPaymentMethod) lookups.push({ objectType: "payment_method", run: () => input.source.fetchPaymentMethod!(references.paymentMethodId!) });
  if (references.customerId && input.source.fetchCustomer) lookups.push({ objectType: "customer", run: () => input.source.fetchCustomer!(references.customerId!) });
  if (references.balanceTransactionId && input.source.fetchBalanceTransaction) lookups.push({ objectType: "balance_transaction", run: () => input.source.fetchBalanceTransaction!(references.balanceTransactionId!) });
  const settled = await Promise.allSettled(lookups.map((lookup) => lookup.run()));
  const payloads: Partial<Record<OptionalObjectType, unknown | null>> = {};
  const issueCodes: string[] = [];
  for (const [index, result] of settled.entries()) {
    const lookup = lookups[index];
    if (!lookup) continue;
    if (result.status === "fulfilled") payloads[lookup.objectType] = result.value;
    else {
      issueCodes.push(`${lookup.objectType}_lookup_failed`);
      if (input.repository.recordOptionalEnrichmentError) await input.repository.recordOptionalEnrichmentError({
        integrationEventId: input.integrationEventId, syncRunId: input.syncRunId, chargeId: input.charge.chargeId, objectType: lookup.objectType, error: result.reason,
      });
    }
  }
  for (const lookup of lookups) {
    if (payloads[lookup.objectType] == null) continue;
    try {
      normaliseStripeEnrichment({
        charge: input.charge, references,
        ...(lookup.objectType === "checkout_session" ? { checkoutContext: payloads.checkout_session } : {}),
        ...(lookup.objectType === "invoice" ? { invoice: payloads.invoice } : {}),
        ...(lookup.objectType === "payment_method" ? { paymentMethod: payloads.payment_method } : {}),
        ...(lookup.objectType === "customer" ? { customer: payloads.customer } : {}),
        ...(lookup.objectType === "balance_transaction" ? { balanceTransaction: payloads.balance_transaction } : {}),
      });
    } catch (error) {
      delete payloads[lookup.objectType];
      issueCodes.push(`${lookup.objectType}_validation_failed`);
      if (input.repository.recordOptionalEnrichmentError) await input.repository.recordOptionalEnrichmentError({
        integrationEventId: input.integrationEventId, syncRunId: input.syncRunId, chargeId: input.charge.chargeId, objectType: lookup.objectType, error,
      });
    }
  }
  const enrichment = normaliseStripeEnrichment({
    charge: input.charge, references,
    checkoutContext: payloads.checkout_session, invoice: payloads.invoice, paymentMethod: payloads.payment_method,
    customer: payloads.customer, balanceTransaction: payloads.balance_transaction,
  });
  return { ...enrichment, issueCodes: [...new Set([...enrichment.issueCodes, ...issueCodes])] };
}

async function persistCharge(input: { charge: unknown; source?: Pick<StripeSource, "fetchCharge"> & StripePlanLookupSource & Partial<StripeSource>; productReferenceMetadataKey: string; repository: StripeRepository; providerEventId?: string; reconciliationSource?: string; syncRunId?: string }): Promise<boolean> {
  let charge = normaliseStripeCharge(input.charge, input.productReferenceMetadataKey);
  let enrichment: NormalisedStripeEnrichment | null = null;
  if (input.source && (input.source.fetchCheckoutContextForPaymentIntent || input.source.fetchInvoice || input.source.fetchPaymentMethod || input.source.fetchCustomer || input.source.fetchBalanceTransaction)) {
    enrichment = await collectStripeEnrichment({ rawCharge: input.charge, charge, source: input.source as StripeSource, repository: input.repository, integrationEventId: input.providerEventId, syncRunId: input.syncRunId });
    charge = applyStripeTransactionEnrichment(charge, enrichment);
  } else {
    const paymentIntentId = charge.sourceMetadata.payment_intent_id;
    if (paymentIntentId && input.source?.fetchCheckoutPlanForPaymentIntent) {
    try {
      const rawPlan = await input.source.fetchCheckoutPlanForPaymentIntent(paymentIntentId);
      const plan = rawPlan ? normaliseStripeCheckoutPlan(rawPlan) : null;
      if (plan) charge = addStripeCheckoutPlan(charge, plan);
    } catch {
      // The Charge remains a valid source record if it was not created through
      // Checkout or the optional plan lookup is unavailable. An unmapped flag
      // keeps it out of financial totals until a verified local mapping exists.
    }
    }
  }
  const result = await input.repository.persistCharge({ ...charge, providerEventId: input.providerEventId, reconciliationSource: input.reconciliationSource });
  if (enrichment && result.paymentId && input.repository.persistStripeDetails) await input.repository.persistStripeDetails(result.paymentId, enrichment);
  return result.inserted;
}

async function persistRefund(input: { refund: unknown; source: Pick<StripeSource, "fetchCharge" | "fetchBalanceTransaction">; productReferenceMetadataKey: string; repository: StripeRepository }): Promise<boolean> {
  const refund = normaliseStripeRefund(input.refund);
  // A refund can arrive before the matching charge's webhook. Read the charge first
  // so the original B2C record always exists before its separate refund row.
  await persistCharge({ charge: await input.source.fetchCharge(refund.chargeId), source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository });
  const result = await input.repository.persistRefund(refund);
  if (refund.balanceTransactionId && input.source.fetchBalanceTransaction && input.repository.persistStripeRefundDetails) {
    try {
      const evidence = normaliseStripeRefundSettlement(await input.source.fetchBalanceTransaction(refund.balanceTransactionId));
      await input.repository.persistStripeRefundDetails(result.refundId, evidence);
    } catch (error) {
      // The source refund remains a valid, separate record if optional settlement
      // evidence is unavailable. Keep a safe error for retry and never create a
      // financial estimate from the missing conversion data.
      if (input.repository.recordOptionalEnrichmentError) await input.repository.recordOptionalEnrichmentError({
        chargeId: refund.chargeId,
        sourceReference: `Stripe refund ${refund.refundId} balance_transaction enrichment`,
        objectType: "balance_transaction",
        error,
      });
    }
  }
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
      await persistCharge({ charge: input.event.data.object, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, providerEventId: input.event.id });
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
        if (await persistCharge({ charge, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, reconciliationSource: "stripe_48_hour_reconciliation", syncRunId: run.id })) inserted += 1;
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
          await persistCharge({ charge, source: input.source, productReferenceMetadataKey: input.productReferenceMetadataKey, repository: input.repository, reconciliationSource: "stripe_historical_backfill", syncRunId: run.id });
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
