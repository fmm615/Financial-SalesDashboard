import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
import type { DatabaseClient } from "@/lib/supabase/server";

type ProviderSyncRun = { id: string };
export type ProviderBackfillRun = { id: string; continuationCursor: string | null; recordsProcessed: number; recordsFailed: number; completed: boolean };
/** @deprecated Kept as an alias while Stripe call sites migrate to the provider-neutral name. */
export type StripeBackfillRun = ProviderBackfillRun;

export type B2cProvider = "stripe" | "tap";

/**
 * Provider data has already been validated and normalised before it reaches
 * the database boundary. Both Stripe and Tap use this exact local shape.
 */
export type NormalisedB2cProviderCharge = {
  chargeId: string;
  customerEmail: string | null;
  customerName: string | null;
  customerPhone: string | null;
  productReference: string | null;
  paymentStatus: "succeeded" | "failed" | "pending";
  originalAmount: string;
  originalCurrency: string;
  exchangeRateToUsd: string;
  amountUsd: string;
  occurredAt: string;
  occurredOn: string;
  sourceMetadata: Record<string, string>;
};

export type NormalisedB2cProviderRefund = {
  refundId: string;
  chargeId: string;
  originalAmount: string;
  originalCurrency: string;
  exchangeRateToUsd: string;
  amountUsd: string;
  occurredAt: string;
  reason: string | null;
  metadata: Record<string, string>;
};

function safeMessage(error: unknown, provider: B2cProvider): string {
  const message = error instanceof Error ? error.message : `Unknown ${provider} integration failure.`;
  return message.replace(/(?:Bearer|sk|rk|whsec)_[^\s,]+/gi, "[redacted]").slice(0, 500);
}

function safeReference(value: string): string { return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }

/** Trusted B2C-provider persistence. Provider HTTP remains outside this repository. */
export class SupabaseB2cProviderSyncRepository {
  constructor(private readonly client: DatabaseClient, private readonly provider: B2cProvider) {}

  private get providerLabel(): string { return this.provider === "stripe" ? "Stripe" : "Tap"; }

  async startSyncRun(rangeStart: Date, rangeEnd: Date): Promise<ProviderSyncRun> {
    const { data, error } = await this.client.from("integration_sync_runs")
      .insert({ provider: this.provider, status: "processing", started_at: rangeStart.toISOString(), requested_range_start: rangeStart.toISOString(), requested_range_end: rangeEnd.toISOString() })
      .select("id").single();
    if (error) throw new Error(`Could not create ${this.providerLabel} sync run: ${error.message}`);
    return data;
  }

  async completeSyncRun(syncRunId: string): Promise<void> {
    const { error } = await this.client.from("integration_sync_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", syncRunId);
    if (error) throw new Error(`Could not complete ${this.providerLabel} sync run: ${error.message}`);
  }

  /** Returns persisted all-history provider progress, or starts a new bounded run. */
  async getOrStartHistoricalBackfill(input: { restartCompleted?: boolean } = {}): Promise<ProviderBackfillRun> {
    const { data: latest, error: latestError } = await this.client.from("integration_sync_runs")
      .select("id,continuation_cursor,records_processed,records_failed,status")
      .eq("provider", this.provider)
      .eq("operation_type", "historical_backfill")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(`Could not load ${this.providerLabel} backfill state: ${latestError.message}`);
    // A failed page keeps its cursor. Retrying must continue from that safe
    // checkpoint rather than download the already-persisted history again.
    if (latest?.status === "processing" || latest?.status === "failed" || (latest?.status === "completed" && !input.restartCompleted)) {
      return { id: latest.id, continuationCursor: latest.continuation_cursor, recordsProcessed: latest.records_processed, recordsFailed: latest.records_failed, completed: latest.status === "completed" };
    }
    const { data, error } = await this.client.from("integration_sync_runs")
      .insert({ provider: this.provider, status: "processing", operation_type: "historical_backfill", started_at: new Date().toISOString() })
      .select("id,continuation_cursor,records_processed,records_failed")
      .single();
    if (error) throw new Error(`Could not start ${this.providerLabel} backfill: ${error.message}`);
    return { id: data.id, continuationCursor: data.continuation_cursor, recordsProcessed: data.records_processed, recordsFailed: data.records_failed, completed: false };
  }

  async finishHistoricalBackfillBatch(input: { runId: string; processed: number; failed: number; nextCursor: string | null }): Promise<ProviderBackfillRun> {
    const { data: current, error: currentError } = await this.client.from("integration_sync_runs")
      .select("records_processed,records_failed")
      .eq("id", input.runId)
      .single();
    if (currentError) throw new Error(`Could not load ${this.providerLabel} backfill totals: ${currentError.message}`);
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
    if (error) throw new Error(`Could not save ${this.providerLabel} backfill progress: ${error.message}`);
    return { id: data.id, continuationCursor: data.continuation_cursor, recordsProcessed: data.records_processed, recordsFailed: data.records_failed, completed };
  }

  async failSyncRun(syncRunId: string, error: unknown): Promise<void> {
    await this.client.from("integration_sync_runs").update({ status: "failed", failed_at: new Date().toISOString(), safe_error_summary: safeMessage(error, this.provider) }).eq("id", syncRunId);
  }

  async recordWebhookEvent(externalEventId: string, eventType: string): Promise<{ id: string; isNew: boolean }> {
    const { data, error } = await this.client.from("integration_events")
      .upsert({ provider: this.provider, external_event_id: externalEventId, event_type: eventType, status: "pending", safe_metadata: {} }, { onConflict: "provider,external_event_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`Could not record ${this.providerLabel} webhook event: ${error.message}`);
    if (data.length === 1) return { id: data[0].id, isNew: true };
    const { data: existing, error: lookupError } = await this.client.from("integration_events").select("id").eq("provider", this.provider).eq("external_event_id", externalEventId).single();
    if (lookupError) throw new Error(`Could not load existing ${this.providerLabel} webhook event: ${lookupError.message}`);
    return { id: existing.id, isNew: false };
  }

  async markEventCompleted(eventId: string): Promise<void> {
    const { error } = await this.client.from("integration_events").update({ status: "completed", processed_at: new Date().toISOString(), processing_attempts: 1 }).eq("id", eventId);
    if (error) throw new Error(`Could not complete ${this.providerLabel} webhook event: ${error.message}`);
  }

  async failEvent(eventId: string, error: unknown, sourceReference: string): Promise<void> {
    await this.client.from("integration_events").update({ status: "failed", processing_attempts: 1 }).eq("id", eventId);
    await this.recordIntegrationError({ integrationEventId: eventId, error, sourceReference });
  }

  async recordSyncError(syncRunId: string, error: unknown, sourceReference: string): Promise<void> {
    await this.recordIntegrationError({ syncRunId, error, sourceReference });
  }

  async persistCharge(input: NormalisedB2cProviderCharge & { providerEventId?: string; reconciliationSource?: string }): Promise<{ inserted: boolean }> {
    const { data: existing, error: existingError } = await this.client.from("b2c_payments")
      .select("id,provider_event_id").eq("source_system", this.provider).eq("provider_transaction_id", input.chargeId).maybeSingle();
    if (existingError) throw new Error(`Could not check existing ${this.providerLabel} charge: ${existingError.message}`);

    const customerId = input.customerEmail ? await this.upsertCustomer(input.customerEmail, input.customerName) : null;
    const mapping = await this.findProductMapping(input.productReference);
    const categoryCode = mapping?.categoryCode ?? "unmapped";
    const duplicateFingerprint = createB2cDuplicateFingerprint({ customerEmail: input.customerEmail, amountUsd: input.amountUsd, categoryCode, occurredOn: input.occurredOn, providerTransactionId: input.chargeId });
    const values = {
      source_system: this.provider, provider_transaction_id: input.chargeId, provider_event_id: input.providerEventId ?? existing?.provider_event_id ?? null,
      customer_id: customerId, customer_email: input.customerEmail, customer_name: input.customerName, customer_phone: input.customerPhone, product_mapping_id: mapping?.id ?? null, category_code: categoryCode,
      // A verified local mapping remains the reporting classification. When no
      // mapping exists, show the direct provider plan name for traceability only.
      membership_tier: mapping?.membershipTier ?? input.sourceMetadata.provider_plan_name ?? null, payment_status: input.paymentStatus, original_amount: input.originalAmount,
      original_currency: input.originalCurrency, exchange_rate_to_usd: input.exchangeRateToUsd, amount_usd: input.amountUsd, gross_amount_usd: input.amountUsd,
      tax_amount_usd: null, net_amount_usd: null, occurred_at: input.occurredAt, occurred_on: input.occurredOn, duplicate_fingerprint: duplicateFingerprint,
      reconciliation_source: input.reconciliationSource ?? null, source_metadata: input.sourceMetadata,
    };
    const { data: payment, error } = existing
      ? await this.client.from("b2c_payments").update(values).eq("id", existing.id).select("id").single()
      : await this.client.from("b2c_payments").insert(values).select("id").single();
    if (error) throw new Error(`Could not save ${this.providerLabel} charge: ${error.message}`);

    if (!input.customerEmail) await this.openFlag(payment.id, "needs_follow_up", `${this.providerLabel} payment is missing a valid customer email. It is retained for traceability and excluded from financial totals until an Admin records a verified local correction.`);
    if (!mapping) await this.openFlag(payment.id, "unmapped_product", `${this.providerLabel} payment has no approved product mapping. It is retained for traceability and excluded from financial totals until an Admin maps the product.`);
    if (input.paymentStatus === "failed") await this.openFlag(payment.id, "failed", `${this.providerLabel} payment failed. It is retained for follow-up and excluded from financial totals.`);
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

  async persistRefund(input: NormalisedB2cProviderRefund): Promise<{ inserted: boolean }> {
    const { data: payment, error: paymentError } = await this.client.from("b2c_payments").select("id").eq("source_system", this.provider).eq("provider_transaction_id", input.chargeId).maybeSingle();
    if (paymentError) throw new Error(`Could not locate ${this.providerLabel} source payment for refund: ${paymentError.message}`);
    if (!payment) throw new Error(`${this.providerLabel} refund refers to charge ${input.chargeId}, which is not stored locally.`);
    const { data: existing, error: existingError } = await this.client.from("b2c_refunds").select("id").eq("source_system", this.provider).eq("provider_refund_id", input.refundId).maybeSingle();
    if (existingError) throw new Error(`Could not check existing ${this.providerLabel} refund: ${existingError.message}`);
    if (existing) return { inserted: false };
    const { data: refund, error } = await this.client.from("b2c_refunds").insert({
      payment_id: payment.id, source_system: this.provider, provider_refund_id: input.refundId, original_amount: input.originalAmount, original_currency: input.originalCurrency,
      exchange_rate_to_usd: input.exchangeRateToUsd, amount_usd: input.amountUsd, reason: input.reason, occurred_at: input.occurredAt, provider_metadata: input.metadata,
    }).select("id").single();
    if (error) throw new Error(`Could not save ${this.providerLabel} refund: ${error.message}`);
    await this.openFlag(refund.id, "refunded", `${this.providerLabel} refund recorded separately from its original payment. Confirm the refund reason before month-end.`, "b2c_refund");
    return { inserted: true };
  }

  private async upsertCustomer(email: string, fullName: string | null): Promise<string> {
    const { data: existing, error: existingError } = await this.client.from("customers").select("id,full_name").eq("email", email).maybeSingle();
    if (existingError) throw new Error(`Could not load ${this.providerLabel} customer: ${existingError.message}`);
    if (existing) {
      if (fullName && fullName !== existing.full_name) {
        const { error: updateError } = await this.client.from("customers").update({ full_name: fullName }).eq("id", existing.id);
        if (updateError) throw new Error(`Could not update ${this.providerLabel} customer: ${updateError.message}`);
      }
      return existing.id;
    }
    const { data, error } = await this.client.from("customers").insert({ email, full_name: fullName }).select("id").single();
    if (error) throw new Error(`Could not save ${this.providerLabel} customer: ${error.message}`);
    return data.id;
  }

  private async findProductMapping(productReference: string | null): Promise<{ id: string; categoryCode: string; membershipTier: string | null } | null> {
    if (!productReference) return null;
    const { data, error } = await this.client.from("product_mappings").select("id,category_code,membership_tier")
      .eq("source_system", this.provider).eq("external_product_id", productReference).maybeSingle();
    if (error) throw new Error(`Could not load ${this.providerLabel} product mapping: ${error.message}`);
    return data ? { id: data.id, categoryCode: data.category_code, membershipTier: data.membership_tier } : null;
  }

  private async findRecentContentDuplicates(paymentId: string, fingerprint: string, occurredAt: string): Promise<string[]> {
    const start = new Date(new Date(occurredAt).getTime() - 48 * 60 * 60 * 1000).toISOString();
    const end = new Date(new Date(occurredAt).getTime() + 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.client.from("b2c_payments").select("id").eq("payment_status", "succeeded").eq("duplicate_fingerprint", fingerprint).gte("occurred_at", start).lte("occurred_at", end).neq("id", paymentId);
    if (error) throw new Error(`Could not check ${this.providerLabel} content duplicates: ${error.message}`);
    return (data ?? []).map((payment) => payment.id);
  }

  private async openFlag(recordId: string, flagType: "unmapped_product" | "failed" | "possible_duplicate" | "refunded" | "needs_follow_up", reason: string, sourceArea: "b2c_payment" | "b2c_refund" = "b2c_payment"): Promise<void> {
    const { error } = await this.client.from("review_flags").upsert({ source_area: sourceArea, source_record_id: recordId, flag_type: flagType, status: "open", priority: 2, reason }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (error) throw new Error(`Could not open Stripe review flag: ${error.message}`);
  }

  private async recordIntegrationError(input: { integrationEventId?: string; syncRunId?: string; error: unknown; sourceReference: string }): Promise<void> {
    const { data, error } = await this.client.from("integration_errors").insert({ provider: this.provider, integration_event_id: input.integrationEventId ?? null, sync_run_id: input.syncRunId ?? null, safe_error_summary: safeMessage(input.error, this.provider), source_reference: safeReference(input.sourceReference) }).select("id").single();
    if (error) throw new Error(`Could not record ${this.providerLabel} integration error: ${error.message}`);
    const { error: flagError } = await this.client.from("review_flags").upsert({ source_area: "integration", source_record_id: data.id, flag_type: "needs_follow_up", status: "open", priority: 2, reason: safeMessage(input.error, this.provider) }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (flagError) throw new Error(`Could not flag ${this.providerLabel} integration error: ${flagError.message}`);
  }
}

/** Backwards-compatible Stripe wrapper around the shared B2C-provider repository. */
export class SupabaseStripeSyncRepository extends SupabaseB2cProviderSyncRepository {
  constructor(client: DatabaseClient) { super(client, "stripe"); }
}

/** Tap uses the same local payment/refund and audit safeguards as Stripe. */
export class SupabaseTapSyncRepository extends SupabaseB2cProviderSyncRepository {
  constructor(client: DatabaseClient) { super(client, "tap"); }
}
