import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
import type { DatabaseClient } from "@/lib/supabase/server";
import type { NormalisedStripeEnrichment, StripeRefundSettlementEvidence } from "@/lib/integrations/stripe/enrichment";

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
  exchangeRateToUsd: string | null;
  amountUsd: string | null;
  occurredAt: string;
  occurredOn: string;
  sourceMetadata: Record<string, string>;
};

export type NormalisedB2cProviderRefund = {
  refundId: string;
  chargeId: string;
  originalAmount: string;
  originalCurrency: string;
  exchangeRateToUsd: string | null;
  amountUsd: string | null;
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

  async persistCharge(input: NormalisedB2cProviderCharge & { providerEventId?: string; reconciliationSource?: string }): Promise<{ paymentId: string; inserted: boolean }> {
    const { data: existing, error: existingError } = await this.client.from("b2c_payments")
      .select("id,provider_event_id,customer_email,customer_name,customer_phone,source_metadata").eq("source_system", this.provider).eq("provider_transaction_id", input.chargeId).maybeSingle();
    if (existingError) throw new Error(`Could not check existing ${this.providerLabel} charge: ${existingError.message}`);

    const existingMetadata = existing?.source_metadata && typeof existing.source_metadata === "object" && !Array.isArray(existing.source_metadata) ? existing.source_metadata as Record<string, unknown> : {};
    const sourcePriority = (value: unknown): number => ({ charge_receipt: 1, charge_billing: 2, charge_shipping: 3, checkout_session: 4, invoice_snapshot: 5 }[typeof value === "string" ? value : ""] ?? 99);
    const mergeContact = (current: string | null | undefined, incoming: string | null, currentSource: unknown, incomingSource: unknown): { value: string | null; source: string | null; conflict: boolean } => {
      const normalizedCurrent = current ?? null;
      const normalizedIncomingSource = typeof incomingSource === "string" ? incomingSource : null;
      const normalizedCurrentSource = typeof currentSource === "string" ? currentSource : null;
      if (!incoming) return { value: normalizedCurrent, source: normalizedCurrentSource, conflict: false };
      if (!normalizedCurrent) return { value: incoming, source: normalizedIncomingSource, conflict: false };
      if (normalizedCurrent.toLocaleLowerCase("en-US") === incoming.toLocaleLowerCase("en-US")) return { value: normalizedCurrent, source: sourcePriority(normalizedIncomingSource) < sourcePriority(normalizedCurrentSource) ? normalizedIncomingSource : normalizedCurrentSource, conflict: false };
      if (sourcePriority(normalizedIncomingSource) < sourcePriority(normalizedCurrentSource)) return { value: incoming, source: normalizedIncomingSource, conflict: true };
      return { value: normalizedCurrent, source: normalizedCurrentSource, conflict: true };
    };
    const mergedName = mergeContact(existing?.customer_name, input.customerName, existingMetadata.customer_name_source, input.sourceMetadata.customer_name_source);
    const mergedEmail = mergeContact(existing?.customer_email, input.customerEmail, existingMetadata.customer_email_source, input.sourceMetadata.customer_email_source);
    const mergedPhone = mergeContact(existing?.customer_phone, input.customerPhone, existingMetadata.customer_phone_source, input.sourceMetadata.customer_phone_source);
    const customerId = mergedEmail.value ? await this.upsertCustomer(mergedEmail.value, mergedName.value) : null;
    const mapping = await this.findProductMapping(input.productReference);
    const categoryCode = mapping?.categoryCode ?? "unmapped";
    const duplicateFingerprint = createB2cDuplicateFingerprint({ customerEmail: mergedEmail.value, amountUsd: input.amountUsd ?? input.originalAmount, originalCurrency: input.originalCurrency, categoryCode, occurredOn: input.occurredOn, providerTransactionId: input.chargeId });
    const values = {
      source_system: this.provider, provider_transaction_id: input.chargeId, provider_event_id: input.providerEventId ?? existing?.provider_event_id ?? null,
      customer_id: customerId, customer_email: mergedEmail.value, customer_name: mergedName.value, customer_phone: mergedPhone.value, product_mapping_id: mapping?.id ?? null, category_code: categoryCode,
      // A verified local mapping remains the reporting classification. When no
      // mapping exists, show the direct provider plan name for traceability only.
      membership_tier: mapping?.membershipTier ?? input.sourceMetadata.provider_plan_name ?? null, payment_status: input.paymentStatus, original_amount: input.originalAmount,
      original_currency: input.originalCurrency, exchange_rate_to_usd: input.exchangeRateToUsd, amount_usd: input.amountUsd, gross_amount_usd: input.amountUsd,
      tax_amount_usd: null, net_amount_usd: null, occurred_at: input.occurredAt, occurred_on: input.occurredOn, duplicate_fingerprint: duplicateFingerprint,
      reconciliation_source: input.reconciliationSource ?? null, source_metadata: {
        ...existingMetadata, ...input.sourceMetadata,
        ...(mergedName.source ? { customer_name_source: mergedName.source } : {}),
        ...(mergedEmail.source ? { customer_email_source: mergedEmail.source } : {}),
        ...(mergedPhone.source ? { customer_phone_source: mergedPhone.source } : {}),
      },
    };
    const { data: payment, error } = existing
      ? await this.client.from("b2c_payments").update(values).eq("id", existing.id).select("id").single()
      : await this.client.from("b2c_payments").insert(values).select("id").single();
    if (error) throw new Error(`Could not save ${this.providerLabel} charge: ${error.message}`);

    if (!mergedEmail.value) await this.openFlag(payment.id, "needs_follow_up", `${this.providerLabel} payment is missing a valid customer email. It is retained for traceability and excluded from financial totals until an Admin records a verified local correction.`);
    if (input.originalCurrency !== "USD" || input.amountUsd === null) await this.openFlag(payment.id, "needs_fx_review", `${this.providerLabel} source payment is in ${input.originalCurrency}. Its source amount is retained, but a Finance-approved USD conversion is required before it can enter USD financial totals.`);
    if (mergedName.conflict || mergedEmail.conflict || mergedPhone.conflict) await this.openFlag(payment.id, "needs_follow_up", `${this.providerLabel} returned conflicting transaction contact evidence. The higher-priority retained value remains in use pending Admin review.`);
    if (!mapping) await this.openFlag(payment.id, "unmapped_product", `${this.providerLabel} payment has no approved product mapping. It is retained for traceability and excluded from financial totals until an Admin maps the product.`);
    if (input.paymentStatus === "failed") await this.openFlag(payment.id, "failed", `${this.providerLabel} payment failed. It is retained for follow-up and excluded from financial totals.`);
    // A failed card attempt followed by a successful retry commonly has the same
    // email, amount, and day. Only two completed payments can be financial
    // duplicate candidates; failed or pending attempts never taint a success.
    if (input.paymentStatus === "succeeded" && mergedEmail.value) {
      const duplicatePaymentIds = await this.findRecentContentDuplicates(payment.id, duplicateFingerprint, input.occurredAt);
      if (duplicatePaymentIds.length) {
        const reason = "Another completed B2C payment has the same customer, amount, category, and Bahrain business date within 48 hours. It is excluded from financial totals pending Admin review.";
        await Promise.all([payment.id, ...duplicatePaymentIds].map((paymentId) => this.openFlag(paymentId, "possible_duplicate", reason)));
      }
    }
    return { paymentId: payment.id, inserted: existing === null };
  }

  async persistStripeDetails(paymentId: string, details: NormalisedStripeEnrichment): Promise<void> {
    if (this.provider !== "stripe") throw new Error("Only Stripe payments can receive Stripe enrichment details.");
    const { data: existing, error: existingError } = await this.client.from("b2c_stripe_payment_details").select("*").eq("payment_id", paymentId).maybeSingle();
    if (existingError) throw new Error(`Could not load Stripe enrichment details: ${existingError.message}`);
    const retained = <T>(incoming: T | null, current: T | null | undefined): T | null => incoming ?? current ?? null;
    const values = {
      payment_id: paymentId,
      payment_intent_id: retained(details.references.paymentIntentId, existing?.payment_intent_id),
      payment_method_id: retained(details.references.paymentMethodId, existing?.payment_method_id),
      checkout_session_id: retained(details.references.checkoutSessionId, existing?.checkout_session_id),
      invoice_id: retained(details.references.invoiceId, existing?.invoice_id),
      customer_id: retained(details.references.customerId, existing?.customer_id),
      balance_transaction_id: retained(details.references.balanceTransactionId, existing?.balance_transaction_id),
      customer_name_source: retained(details.transactionContact.nameSource, existing?.customer_name_source),
      customer_email_source: retained(details.transactionContact.emailSource, existing?.customer_email_source),
      customer_phone_source: retained(details.transactionContact.phoneSource, existing?.customer_phone_source),
      charge_customer_name: retained(details.chargeContact.name, existing?.charge_customer_name),
      charge_customer_email: retained(details.chargeContact.email, existing?.charge_customer_email),
      charge_customer_phone: retained(details.chargeContact.phone, existing?.charge_customer_phone),
      checkout_customer_name: retained(details.checkoutContact.name, existing?.checkout_customer_name),
      checkout_customer_email: retained(details.checkoutContact.email, existing?.checkout_customer_email),
      checkout_customer_phone: retained(details.checkoutContact.phone, existing?.checkout_customer_phone),
      invoice_customer_name: retained(details.invoiceContact.name, existing?.invoice_customer_name),
      invoice_customer_email: retained(details.invoiceContact.email, existing?.invoice_customer_email),
      invoice_customer_phone: retained(details.invoiceContact.phone, existing?.invoice_customer_phone),
      payment_method_customer_name: retained(details.paymentMethodContact.name, existing?.payment_method_customer_name),
      payment_method_customer_email: retained(details.paymentMethodContact.email, existing?.payment_method_customer_email),
      payment_method_customer_phone: retained(details.paymentMethodContact.phone, existing?.payment_method_customer_phone),
      customer_profile_name: retained(details.customerProfileContact.name, existing?.customer_profile_name),
      customer_profile_email: retained(details.customerProfileContact.email, existing?.customer_profile_email),
      customer_profile_phone: retained(details.customerProfileContact.phone, existing?.customer_profile_phone),
      charge_description: retained(details.chargeEvidence.description, existing?.charge_description),
      seller_message: retained(details.chargeEvidence.sellerMessage, existing?.seller_message),
      cardholder_name: retained(details.chargeEvidence.cardholderName, existing?.cardholder_name),
      charge_refunded_amount: details.chargeEvidence.amountRefunded,
      settlement_gross_amount: retained(details.settlement?.grossAmount ?? null, existing?.settlement_gross_amount),
      settlement_fee_amount: retained(details.settlement?.feeAmount ?? null, existing?.settlement_fee_amount),
      settlement_fee_tax_amount: retained(details.settlement?.feeTaxAmount ?? null, existing?.settlement_fee_tax_amount),
      settlement_net_amount: retained(details.settlement?.netAmount ?? null, existing?.settlement_net_amount),
      settlement_currency: retained(details.settlement?.currency ?? null, existing?.settlement_currency),
      settlement_exchange_rate: retained(details.settlement?.exchangeRate ?? null, existing?.settlement_exchange_rate),
      provider_tax_amount: retained(details.providerTax?.amount ?? null, existing?.provider_tax_amount),
      provider_tax_currency: retained(details.providerTax?.currency ?? null, existing?.provider_tax_currency),
      enrichment_status: details.issueCodes.length ? "partial" as const : "complete" as const,
      enrichment_issue_codes: details.issueCodes,
      last_enriched_at: details.issueCodes.length ? existing?.last_enriched_at ?? null : new Date().toISOString(),
    };
    const { error } = await this.client.from("b2c_stripe_payment_details").upsert(values, { onConflict: "payment_id" });
    if (error) throw new Error(`Could not save Stripe enrichment details: ${error.message}`);
    if (details.issueCodes.some((code) => code.startsWith("contact_conflict_"))) await this.openFlag(paymentId, "needs_follow_up", "Stripe returned conflicting transaction contact evidence. The retained higher-priority value requires Admin review.");
  }

  async recordOptionalEnrichmentError(input: { integrationEventId?: string; syncRunId?: string; chargeId: string; sourceReference?: string; objectType: "checkout_session" | "invoice" | "payment_method" | "customer" | "balance_transaction"; error: unknown }): Promise<void> {
    await this.recordIntegrationError({
      integrationEventId: input.integrationEventId,
      syncRunId: input.syncRunId,
      error: input.error,
      sourceReference: input.sourceReference ?? `Stripe charge ${input.chargeId} ${input.objectType} enrichment`,
    });
  }

  async persistRefund(input: NormalisedB2cProviderRefund): Promise<{ refundId: string; inserted: boolean }> {
    const { data: payment, error: paymentError } = await this.client.from("b2c_payments").select("id").eq("source_system", this.provider).eq("provider_transaction_id", input.chargeId).maybeSingle();
    if (paymentError) throw new Error(`Could not locate ${this.providerLabel} source payment for refund: ${paymentError.message}`);
    if (!payment) throw new Error(`${this.providerLabel} refund refers to charge ${input.chargeId}, which is not stored locally.`);
    const { data: existing, error: existingError } = await this.client.from("b2c_refunds").select("id").eq("source_system", this.provider).eq("provider_refund_id", input.refundId).maybeSingle();
    if (existingError) throw new Error(`Could not check existing ${this.providerLabel} refund: ${existingError.message}`);
    if (existing) return { refundId: existing.id, inserted: false };
    const { data: refund, error } = await this.client.from("b2c_refunds").insert({
      payment_id: payment.id, source_system: this.provider, provider_refund_id: input.refundId, original_amount: input.originalAmount, original_currency: input.originalCurrency,
      exchange_rate_to_usd: input.exchangeRateToUsd, amount_usd: input.amountUsd, reason: input.reason, occurred_at: input.occurredAt, provider_metadata: input.metadata,
    }).select("id").single();
    if (error) throw new Error(`Could not save ${this.providerLabel} refund: ${error.message}`);
    await this.openFlag(refund.id, "refunded", `${this.providerLabel} refund recorded separately from its original payment. Confirm the refund reason before month-end.`, "b2c_refund");
    if (input.originalCurrency !== "USD" || input.amountUsd === null) {
      await this.openFlag(refund.id, "needs_fx_review", `${this.providerLabel} source refund is in ${input.originalCurrency}. Its source amount is retained, but a Finance-approved USD conversion is required before it can reduce USD financial totals.`, "b2c_refund");
    }
    return { refundId: refund.id, inserted: true };
  }

  /** Persists only normalized refund settlement evidence; no provider payload is stored. */
  async persistStripeRefundDetails(refundId: string, evidence: StripeRefundSettlementEvidence): Promise<void> {
    if (this.provider !== "stripe") throw new Error("Only Stripe refunds can receive Stripe settlement evidence.");
    const { error } = await this.client.from("b2c_stripe_refund_details").upsert({
      refund_id: refundId,
      settlement_refund_amount: evidence.refundAmount,
      settlement_currency: evidence.currency,
      settlement_exchange_rate: evidence.exchangeRate,
      last_enriched_at: new Date().toISOString(),
    }, { onConflict: "refund_id" });
    if (error) throw new Error(`Could not save Stripe refund settlement evidence: ${error.message}`);
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

  private async openFlag(recordId: string, flagType: "unmapped_product" | "failed" | "possible_duplicate" | "refunded" | "needs_follow_up" | "needs_fx_review", reason: string, sourceArea: "b2c_payment" | "b2c_refund" = "b2c_payment"): Promise<void> {
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
