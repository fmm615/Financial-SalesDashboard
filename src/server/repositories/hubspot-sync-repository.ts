import type { NormalisedHubSpotDeal } from "@/lib/integrations/hubspot/normalise";
import type { DatabaseClient } from "@/lib/supabase/server";

export type HubSpotCompanyInput = {
  externalCompanyId: string;
  legalName: string;
  domain: string | null;
};

export type HubSpotPersistedDeal = NormalisedHubSpotDeal & {
  company: HubSpotCompanyInput;
  ownerName: string | null;
};

export type HubSpotSyncRun = { id: string };
export type HubSpotBackfillRun = { id: string; continuationCursor: string | null; recordsProcessed: number; recordsFailed: number; completed: boolean };

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown HubSpot integration failure.";
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 500);
}

function safeSourceReference(reference: string | undefined): string | undefined {
  const cleaned = reference?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}

/** Database access for trusted HubSpot ingestion; no UI or provider HTTP lives here. */
export class SupabaseHubSpotSyncRepository {
  constructor(private readonly client: DatabaseClient) {}

  async startSyncRun(rangeStart: Date, rangeEnd: Date): Promise<HubSpotSyncRun> {
    const { data, error } = await this.client
      .from("integration_sync_runs")
      .insert({ provider: "hubspot", status: "processing", started_at: rangeStart.toISOString(), requested_range_start: rangeStart.toISOString(), requested_range_end: rangeEnd.toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(`Could not create HubSpot sync run: ${error.message}`);
    return data;
  }

  async completeSyncRun(syncRunId: string): Promise<void> {
    const { error } = await this.client.from("integration_sync_runs")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", syncRunId);
    if (error) throw new Error(`Could not complete HubSpot sync run: ${error.message}`);
  }

  async getOrStartHistoricalBackfill(input: { restartCompleted?: boolean } = {}): Promise<HubSpotBackfillRun> {
    const { data: latest, error: activeError } = await this.client.from("integration_sync_runs")
      .select("id,continuation_cursor,records_processed,records_failed,status")
      .eq("provider", "hubspot")
      .eq("operation_type", "historical_backfill")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeError) throw new Error(`Could not load HubSpot backfill state: ${activeError.message}`);
    if (latest?.status === "processing" || (latest?.status === "completed" && !input.restartCompleted)) {
      return { id: latest.id, continuationCursor: latest.continuation_cursor, recordsProcessed: latest.records_processed, recordsFailed: latest.records_failed, completed: latest.status === "completed" };
    }

    const { data, error } = await this.client.from("integration_sync_runs")
      .insert({ provider: "hubspot", status: "processing", operation_type: "historical_backfill", started_at: new Date().toISOString() })
      .select("id,continuation_cursor,records_processed,records_failed")
      .single();
    if (error) throw new Error(`Could not start HubSpot backfill: ${error.message}`);
    return { id: data.id, continuationCursor: data.continuation_cursor, recordsProcessed: data.records_processed, recordsFailed: data.records_failed, completed: false };
  }

  async finishHistoricalBackfillBatch(input: { runId: string; processed: number; failed: number; nextCursor: string | null }): Promise<HubSpotBackfillRun & { completed: boolean }> {
    const { data: current, error: currentError } = await this.client.from("integration_sync_runs")
      .select("records_processed,records_failed")
      .eq("id", input.runId)
      .single();
    if (currentError) throw new Error(`Could not load HubSpot backfill totals: ${currentError.message}`);
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
    if (error) throw new Error(`Could not save HubSpot backfill progress: ${error.message}`);
    return { id: data.id, continuationCursor: data.continuation_cursor, recordsProcessed: data.records_processed, recordsFailed: data.records_failed, completed };
  }

  async failSyncRun(syncRunId: string, error: unknown): Promise<void> {
    await this.client.from("integration_sync_runs")
      .update({ status: "failed", failed_at: new Date().toISOString(), safe_error_summary: safeMessage(error) })
      .eq("id", syncRunId);
  }

  async recordWebhookEvent(externalEventId: string, eventType: string): Promise<{ id: string; isNew: boolean }> {
    const { data, error } = await this.client
      .from("integration_events")
      .upsert({
        provider: "hubspot",
        external_event_id: externalEventId,
        event_type: eventType,
        status: "pending",
        safe_metadata: {},
      }, { onConflict: "provider,external_event_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`Could not record HubSpot webhook event: ${error.message}`);
    if (data.length === 1) return { id: data[0].id, isNew: true };

    const { data: existing, error: lookupError } = await this.client
      .from("integration_events")
      .select("id")
      .eq("provider", "hubspot")
      .eq("external_event_id", externalEventId)
      .single();
    if (lookupError) throw new Error(`Could not load existing HubSpot webhook event: ${lookupError.message}`);
    return { id: existing.id, isNew: false };
  }

  async markEventCompleted(eventId: string): Promise<void> {
    const { error } = await this.client.from("integration_events")
      .update({ status: "completed", processed_at: new Date().toISOString(), processing_attempts: 1 })
      .eq("id", eventId);
    if (error) throw new Error(`Could not complete HubSpot webhook event: ${error.message}`);
  }

  async failEvent(eventId: string, error: unknown, sourceReference?: string): Promise<void> {
    const safeErrorSummary = safeMessage(error);
    await this.client.from("integration_events")
      .update({ status: "failed", processing_attempts: 1 })
      .eq("id", eventId);
    await this.recordIntegrationError({ integrationEventId: eventId, safeErrorSummary, sourceReference });
  }

  async recordSyncError(syncRunId: string, error: unknown, sourceReference?: string): Promise<void> {
    await this.recordIntegrationError({ syncRunId, safeErrorSummary: safeMessage(error), sourceReference });
  }

  async persistDeal(input: HubSpotPersistedDeal): Promise<void> {
    const companyId = await this.upsertCompany(input.company);
    const dealId = await this.upsertDeal(companyId, input);
    if (input.financialStatus === "complete") {
      const { error } = await this.client.rpc("flag_hubspot_possible_duplicates", { p_deal_id: dealId });
      if (error) throw new Error(`Could not assess HubSpot duplicate candidates: ${error.message}`);
    }

    for (const history of input.stageHistory) {
      const { error } = await this.client.from("b2b_deal_stage_history")
        .upsert({
          deal_id: dealId,
          stage_code: history.stageCode,
          changed_at: history.changedAt,
          source_system: "hubspot",
          external_event_id: history.externalEventId,
        }, { onConflict: "deal_id,stage_code,changed_at", ignoreDuplicates: true });
      if (error) throw new Error(`Could not save HubSpot stage history: ${error.message}`);
    }

    if (input.financialStatus === "needs_review") {
      await this.createIncompleteDealReviewFlag(dealId);
      return;
    }

    if (!input.pipelineOriginalAmount || !input.originalCurrency || !input.exchangeRateToUsd || !input.pipelineAmountUsd) {
      throw new Error("Complete HubSpot deal is missing a financial value.");
    }

    // A closed-won HubSpot deal is a booking. This never creates recognised sales.
    if (input.stageCode === "closed_won") {
      if (!input.hubspotCloseDate) {
        await this.createMissingCloseDateReviewFlag(dealId);
        return;
      }
      const { error } = await this.client.from("b2b_bookings")
        .upsert({
          deal_id: dealId,
          source_system: "hubspot",
          booking_date: input.hubspotCloseDate,
          original_amount: input.pipelineOriginalAmount,
          original_currency: input.originalCurrency,
          exchange_rate_to_usd: input.exchangeRateToUsd,
          booking_amount_usd: input.pipelineAmountUsd,
          source_reference: `HubSpot deal ${input.externalDealId}`,
        }, { onConflict: "deal_id" });
      if (error) throw new Error(`Could not save HubSpot booking: ${error.message}`);
    }
  }

  private async upsertCompany(input: HubSpotCompanyInput): Promise<string> {
    const { data, error } = await this.client.from("b2b_companies")
      .upsert({ source_system: "hubspot", external_company_id: input.externalCompanyId, legal_name: input.legalName, domain: input.domain }, { onConflict: "source_system,external_company_id" })
      .select("id")
      .single();
    if (error) throw new Error(`Could not upsert HubSpot company: ${error.message}`);
    return data.id;
  }

  private async upsertDeal(companyId: string, input: HubSpotPersistedDeal): Promise<string> {
    const changes = {
      company_id: companyId,
      name: input.name,
      stage_code: input.stageCode,
      financial_status: input.financialStatus,
      pipeline_original_amount: input.pipelineOriginalAmount,
      original_currency: input.originalCurrency,
      exchange_rate_to_usd: input.exchangeRateToUsd,
      pipeline_amount_usd: input.pipelineAmountUsd,
      hubspot_close_date: input.hubspotCloseDate,
      renewal_date: input.renewalDate,
      owner_name: input.ownerName,
      source_metadata: input.sourceMetadata,
      imported_at: new Date().toISOString(),
    };
    const { data, error } = await this.client.from("b2b_deals")
      .upsert({ source_system: "hubspot", external_deal_id: input.externalDealId, ...changes }, { onConflict: "source_system,external_deal_id" })
      .select("id")
      .single();
    if (error) throw new Error(`Could not upsert HubSpot deal: ${error.message}`);
    return data.id;
  }

  private async createIncompleteDealReviewFlag(dealId: string): Promise<void> {
    const { error } = await this.client.from("review_flags")
      .upsert({
        source_area: "b2b_deal",
        source_record_id: dealId,
        flag_type: "needs_follow_up",
        priority: 2,
        reason: "HubSpot deal was imported with no amount. It is excluded from financial totals and requires an Admin correction.",
        status: "open",
      }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (error) throw new Error(`Could not flag incomplete HubSpot deal for review: ${error.message}`);
  }

  private async createMissingCloseDateReviewFlag(dealId: string): Promise<void> {
    const { error } = await this.client.from("review_flags")
      .upsert({
        source_area: "b2b_deal",
        source_record_id: dealId,
        flag_type: "needs_follow_up",
        priority: 2,
        reason: "HubSpot marked this deal closed-won without a close date. It is excluded from bookings until an Admin records a local, audited close-date correction.",
        status: "open",
      }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (error) throw new Error(`Could not flag HubSpot deal missing a close date: ${error.message}`);
  }

  private async recordIntegrationError(input: { integrationEventId?: string; syncRunId?: string; safeErrorSummary: string; sourceReference?: string }): Promise<void> {
    const { data, error } = await this.client.from("integration_errors")
      .insert({
        provider: "hubspot",
        integration_event_id: input.integrationEventId ?? null,
        sync_run_id: input.syncRunId ?? null,
        safe_error_summary: input.safeErrorSummary,
        source_reference: safeSourceReference(input.sourceReference) ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not record HubSpot integration error: ${error.message}`);

    const { error: flagError } = await this.client.from("review_flags")
      .upsert({
        source_area: "integration",
        source_record_id: data.id,
        flag_type: "needs_follow_up",
        status: "open",
        priority: 2,
        reason: input.safeErrorSummary,
      }, { onConflict: "source_area,source_record_id,flag_type,status", ignoreDuplicates: true });
    if (flagError) throw new Error(`Could not flag HubSpot integration error for review: ${flagError.message}`);
  }
}
