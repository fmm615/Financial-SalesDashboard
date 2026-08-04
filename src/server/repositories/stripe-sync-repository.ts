import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
import type { NormalisedStripeCharge, NormalisedStripeRefund } from "@/lib/integrations/stripe/normalise";
import type { DatabaseClient } from "@/lib/supabase/server";

type StripeSyncRun = { id: string };
export type StripeBackfillRun = { id: string; continuationCursor: string | null; recordsProcessed: number; recordsFailed: number; completed: boolean };

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Stripe integration failure.";
  return message.replace(/(?:Bearer|sk|rk|whsec)_[^\s,]+/gi, "[redacted]").slice(0, 500);
}

function safeReference(value: string): string { return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }

/** Trusted persistence for Stripe webhooks and reconciliation. Provider HTTP remains outside this repository. */
export class SupabaseStripeSyncRepository {
  constructor(private readonly client: DatabaseClient) {}

  async startSyncRun(rangeStart: Date, rangeEnd: Date): Promise<StripeSyncRun> {
    const { data, error } = await this.client.from("integration_sync_runs")
      .insert({ provider: "stripe", status: "processing", started_at: rangeStart.toISOString(), requested_range_start: rangeStart.toISOString(), requested_range_end: rangeEnd.toISOString() })
      .select("id").single();
    if (error) throw new Error(`Could not create Stripe sync run: ${error.message}`);
    return data;
  }

  async completeSyncRun(syncRunId: string): Promise<void> {
    const { error } = await this.client.from("integration_sync_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", syncRunId);
    if (error) throw new Error(`Could not complete Stripe sync run: ${error.message}`);
  }

  /** Returns persisted all-history Stripe progress, or starts a new bounded run. */
  async getOrStartHistoricalBackfill(input: { restartCompleted?: boolean } = {}): Promise<StripeBackfillRun> {
    const { data: latest, error: latestError } = await this.client.from("integration_sync_runs")
      .select("id,continuation_cursor,records_processed,records_failed,status")
      .eq("provider", "stripe")
      .eq("operation_type", "historical_backfill")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(`Could not load Stripe backfill state: ${latestError.message}`);
    if (latest?.status === "processing" || (latest?.status === "completed" && !input.restartCompleted)) {
      return { id: latest.id, continuationCursor: latest.continuation_cursor, recordsProcessed: latest.records_processed, recordsFailed: latest.records_failed, completed: latest.status === "completed" };
    }
    const { data, error } = await this.client.from("integration_sync_runs")
      .insert({ provider: "stripe", status: "processing", operation_type: "historical_backfill", started_at: new Date().toISOString() })
      .select("id,continuation_cursor,records_processed,records_failed")
      .single();
    if (error) throw new Error(`Could not start Stripe backfill: ${error.message}`);
    return { id: data.id, continuationCursor: data.continuation_cursor, recordsProcessed: data.records_processed, recordsFailed: data.records_failed, completed: false };
  }

  async finishHistoricalBackfillBatch(input: { runId: string; processed: number; failed: number; nextCursor: string | null }): Promise<StripeBackfillRun> {
    const { data: current, error: currentError } = await this.client.from("integration_sync_runs")
      .select("records_processed,records_failed")
      .eq("id", input.runId)
      .single();
    if (currentError) throw new Error(`Could not load Stripe backfill totals: ${currentError.message}`);
    const completed = input.nextCursor === null;
    const { data, error } = await this.client.from("integration_sync_runs")
      .update({
        continuation_cursor: input.nextCursor,
        records_processed: current.records_processed + input.processed,
        records_failed: current.records_failed + input.failed,
        status: completed ? "completed" : "processing",
        completed_at: completed ? new Date().toISOString() : null,
      })
      .eq("id", input.runId)
      .select("id,continuation_cursor,records_processed,records_failed")
      .single();
    if (error) throw new Error(`Could not save Stripe backfill progress: ${error.message}`);
    return { id: data.id, continuationCursor: data.continuation_cursor, recordsProcessed: data.records_processed, recordsFailed: data.records_failed, completed };
  }

  async failSyncRun(syncRunId: string, error: unknown): Promise<void> {
    await this.client.from("integration_sync_runs").update({ status: "failed", failed_at: new Date().toISOString(), safe_error_summary: safeMessage(error) }).eq("id", syncRunId);
  }

  async recordWebhookEvent(externalEventId: string, eventType: string): Promise<{ id: string; isNew: boolean }> {
    const { data, error } = await this.client.from("integration_events")
      .upsert({ provider: "stripe", external_event_id: externalEventId, event_type: eventType, status: "pending", safe_metadata: {} }, { onConflict: "provider,external_event_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`Could not record Stripe webhook event: ${error.message}`);
    if (data.length === 1) return { id: data[0].id, isNew: true };
    const { data: existing, error: lookupError } = await this.client.from("integration_events").select("id").eq("provider", "stripe").eq("external_event_id", externalEventId).single();
    if (lookupError) throw new Error(`Could not load existing Stripe webhook event: ${lookupError.message}`);
    return { id: existing.id, isNew: false };
  }

  async markEventCompleted(eventId: string): Promise<void> {
    const { error } = await this.client.from("integration_events").update({ status: "completed", processed_at: new Date().toISOString(), processing_attempts: 1 }).eq("id", eventId);
    if (error) throw new Error(`Could not complete Stripe webhook event: ${error.message}`);
  }

  async failEvent(eventId: string, error: unknown, sourceReference: string): Promise<void> {
    await this.client.from("integration_events").update({ status: "failed", processing_attempts: 1 }).eq("id", eventId);
    await this.recordIntegrationError({ integrationEventId: eventId, error, sourceReference });
  }

  async recordSyncError(syncRunId: string, error: unknown, sourceReference: string): Promise<void> {
    await this.recordIntegrationError({ syncRunId, error, sourceReference });
  }

  async persistCharge(input: NormalisedStripeCharge & { providerEventId?: string; reconciliationSource?: string }): Promise<{ inserted: boolean }> {
    const { data: existing, error: existingError } = await this.client.from("b2c_payments")
      .select("id,provider_event_id").eq("source_system", "stripe").eq("provider_transaction_id", input.chargeId).maybeSingle();
    if (existingError) throw new Error(`Could not check existing Stripe charge: ${existingError.message}`);

    const customerId = input.customerEmail ? await this.upsertCustomer(input.customerEmail, input.customerName) : null;
    const mapping = await this.findProductMapping(input.productReference);
    const categoryCode = mapping?.categoryCode ?? "unmapped";
    const duplicateFingerprint = createB2cDuplicateFingerprint({ customerEmail: input.customerEmail, amountUsd: input.amountUsd, categoryCode, occurredOn: input.occurredOn, providerTransactionId: input.chargeId });
    const values = {
      source_system: "stripe" as const, provider_transaction_id: input.chargeId, provider_event_id: input.providerEventId ?? existing?.provider_event_id ?? null,
      customer_id: customerId, customer_email: input.customerEmail, customer_name: input.customerName, customer_phone: input.customerPhone, product_mapping_id: mapping?.id ?? null, category_code: categoryCode,
      membership_tier: mapping?.membershipTier ?? null, payment_status: input.paymentStatus, original_amount: input.originalAmount,
      original_currency: input.originalCurrency, exchange_rate_to_usd: input.exchangeRateToUsd, amount_usd: input.amountUsd, gross_amount_usd: input.amountUsd,
      tax_amount_usd: null, net_amount_usd: null, occurred_at: input.occurredAt, occurred_on: input.occurredOn, duplicate_fingerprint: duplicateFingerprint,
      reconciliation_source: input.reconciliationSource ?? null, source_metadata: input.sourceMetadata,
    };
    const { data: payment, error } = existing
      ? await this.client.from("b2c_payments").update(values).eq("id", existing.id).select("id").single()
      : await this.client.from("b2c_payments").insert(values).select("id").single();
    if (error) throw new Error(`Could not save Stripe charge: ${error.message}`);

    if (!input.customerEmail) await this.openFlag(payment.id, "needs_follow_up", "Stripe payment is missing a valid customer email. It is retained for traceability and excluded from financial totals until an Admin records a verified local correction.");
    if (!mapping) await this.openFlag(payment.id, "unmapped_product", "Stripe payment has no approved product mapping. It is retained for traceability and excluded from financial totals until an Admin maps the product.");
    if (input.paymentStatus === "failed") await this.openFlag(payment.id, "failed", "Stripe payment failed. It is retained for follow-up and excluded from financial totals.");
    // A failed card attempt followed by a successful retry commonly has the same
    // email, amount, and day. Only two completed payments can be financial
    // duplicate candidates; failed or pending attempts never taint a success.
    if (input.paymentStatus === "succeeded" && input.customerEmail) {
      const duplicatePaymentIds = await this.findRecentContentDuplicates(payment.id, duplicateFingerprint, input.occurredAt);
      if (duplicatePaymentIds.length) {
        const reason = "Another completed B2C payment has the same customer, amount, category, and Bahrain business date within 48 hours. It is excluded from financial totals pending Admin review.";
        await Promise.all([payment.id, ...duplicatePaymentIds].map((paymentId) => this.openFlag(paymentId, "possible_duplicate", reason)));
      }
    }
    return { inserted: existing === null };
  }

  async persistRefund(input: NormalisedStripeRefund): Promise<{ inserted: boolean }> {
    const { data: payment, error: paymentError } = await this.client.from("b2c_payments").select("id").eq("source_system", "stripe").eq("provider_transaction_id", input.chargeId).maybeSingle();
    if (paymentError) throw new Error(`Could not locate Stripe source payment for refund: ${paymentError.message}`);
    if (!payment) throw new Error(`Stripe refund refers to charge ${input.chargeId}, which is not stored locally.`);
    const { data: existing, error: existingError } = await this.client.from("b2c_refunds").select("id").eq("source_system", "stripe").eq("provider_refund_id", input.refundId).maybeSingle();
    if (existingError) throw new Error(`Could not check existing Stripe refund: ${existingError.message}`);
    if (existing) return { inserted: false };
    const { data: refund, error } = await this.client.from("b2c_refunds").insert({
      payment_id: payment.id, source_system: "stripe", provider_refund_id: input.refundId, original_amount: input.originalAmount, original_currency: input.originalCurrency,
      exchange_rate_to_usd: input.exchangeRateToUsd, amount_usd: input.amountUsd, reason: input.reason, occurred_at: input.occurredAt, provider_metadata: input.metadata,
    }).select("id").single();
    if (error) throw new Error(`Could not save Stripe refund: ${error.message}`);
    await this.openFlag(refund.id, "refunded", "Stripe refund recorded separately from its original payment. Confirm the refund reason before month-end.", "b2c_refund");
    return { inserted: true };
  }

  private async upsertCustomer(email: string, fullName: string | null): Promise<string> {
    const { data: existing, error: existingError } = await this.client.from("customers").select("id,full_name").eq("email", email).maybeSingle();
    if (existingError) throw new Error(`Could not load Stripe customer: ${existingError.message}`);
    if (existing) {
      if (fullName && fullName !== existing.full_name) {
        const { error: updateError } = await this.client.from("customers").update({ full_name: fullName }).eq("id", existing.id);
        if (updateError) throw new Error(`Could not update Stripe customer: ${updateError.message}`);
      }
      return existing.id;
    }
    const { data, error } = await this.client.from("customers").insert({ email, full_name: fullName }).select("id").single();
    if (error) throw new Error(`Could not save Stripe customer: ${error.message}`);
    return data.id;
  }

  private async findProductMapping(productReference: string | null): Promise<{ id: string; categoryCode: string; membershipTier: string | null } | null> {
    if (!productReference) return null;
    const { data, error } = await this.client.from("product_mappings").select("id,category_code,membership_tier")
      .eq("source_system", "stripe").eq("external_product_id", productReference).maybeSingle();
    if (error) throw new Error(`Could not load Stripe product mapping: ${error.message}`);
    return data ? { id: data.id, categoryCode: data.category_code, membershipTier: data.membership_tier } : null;
  }

  private async findRecentContentDuplicates(paymentId: string, fingerprint: string, occurredAt: string): Promise<string[]> {
    const start = new Date(new Date(occurredAt).getTime() - 48 * 60 * 60 * 1000).toISOString();
    const end = new Date(new Date(occurredAt).getTime() + 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.client.from("b2c_payments").select("id").eq("payment_status", "succeeded").eq("duplicate_fingerprint", fingerprint).gte("occurred_at", start).lte("occurred_at", end).neq("id", paymentId);
    if (error) throw new Error(`Could not check Stripe content duplicates: ${error.message}`);
    return (data ?? []).map((payment) => payment.id);
  }

  private async openFlag(recordId: string, flagType: "unmapped_product" | "failed" | "possible_duplicate" | "refunded" | "needs_follow_up", reason: string, sourceArea: "b2c_payment" | "b2c_refund" = "b2c_payment"): Promise<void> {
    const { error } = await this.client.from("review_flags").upsert({ source_area: sourceArea, source_record_id: recordId, flag_type: flagType, status: "open", priority: 2, reason }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (error) throw new Error(`Could not open Stripe review flag: ${error.message}`);
  }

  private async recordIntegrationError(input: { integrationEventId?: string; syncRunId?: string; error: unknown; sourceReference: string }): Promise<void> {
    const { data, error } = await this.client.from("integration_errors").insert({ provider: "stripe", integration_event_id: input.integrationEventId ?? null, sync_run_id: input.syncRunId ?? null, safe_error_summary: safeMessage(input.error), source_reference: safeReference(input.sourceReference) }).select("id").single();
    if (error) throw new Error(`Could not record Stripe integration error: ${error.message}`);
    const { error: flagError } = await this.client.from("review_flags").upsert({ source_area: "integration", source_record_id: data.id, flag_type: "needs_follow_up", status: "open", priority: 2, reason: safeMessage(input.error) }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (flagError) throw new Error(`Could not flag Stripe integration error: ${flagError.message}`);
  }
}
