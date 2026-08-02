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

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown HubSpot integration failure.";
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 500);
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

  async failEvent(eventId: string, error: unknown): Promise<void> {
    const safeErrorSummary = safeMessage(error);
    await this.client.from("integration_events")
      .update({ status: "failed", processing_attempts: 1 })
      .eq("id", eventId);
    await this.client.from("integration_errors")
      .insert({ provider: "hubspot", integration_event_id: eventId, safe_error_summary: safeErrorSummary });
  }

  async recordSyncError(syncRunId: string, error: unknown): Promise<void> {
    await this.client.from("integration_errors")
      .insert({ provider: "hubspot", sync_run_id: syncRunId, safe_error_summary: safeMessage(error) });
  }

  async persistDeal(input: HubSpotPersistedDeal): Promise<void> {
    const companyId = await this.upsertCompany(input.company);
    const dealId = await this.upsertDeal(companyId, input);

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

    // A closed-won HubSpot deal is a booking. This never creates recognised sales.
    if (input.stageCode === "closed_won") {
      if (!input.hubspotCloseDate) throw new Error("Closed-won HubSpot deal has no close date.");
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
}
