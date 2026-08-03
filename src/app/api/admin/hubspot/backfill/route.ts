import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { HubSpotClient } from "@/lib/integrations/hubspot/client";
import { getHubSpotConfig } from "@/lib/integrations/hubspot/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";
import { runHubSpotHistoricalBackfillBatch } from "@/server/services/sync-hubspot";

export const runtime = "nodejs";

const backfillRequestSchema = z.object({
  restartCompleted: z.boolean().optional(),
});

/** Starts or resumes one bounded, read-only page of the all-history B2B import. */
export async function POST(request: NextRequest) {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = backfillRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid historical backfill request." }, { status: 422 });

  try {
    const config = getHubSpotConfig();
    const serviceClient = createServiceDatabaseClient();
    const result = await runHubSpotHistoricalBackfillBatch({
      source: new HubSpotClient(config),
      config,
      repository: new SupabaseHubSpotSyncRepository(serviceClient),
      restartCompleted: parsed.data.restartCompleted,
    });
    await serviceClient.from("audit_events").insert({
      actor_profile_id: user.id,
      actor_email: user.email ?? null,
      area: "hubspot_historical_backfill",
      action: "insert",
      request_context: { run_id: result.runId, processed: result.processed, failed: result.failed, has_more: result.hasMore },
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("HubSpot historical backfill failed:", error instanceof Error ? error.message : "Unknown failure");
    return NextResponse.json({ error: "HubSpot historical backfill could not be completed. Review HubSpot integration issues." }, { status: 500 });
  }
}
