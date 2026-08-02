import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { HubSpotClient } from "@/lib/integrations/hubspot/client";
import { getHubSpotConfig } from "@/lib/integrations/hubspot/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";
import { runHubSpotReconciliation } from "@/server/services/sync-hubspot";

export const runtime = "nodejs";

function safeConfigurationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "HubSpot configuration is incomplete.";
  return message.includes("HUBSPOT_") ? message : "HubSpot configuration is invalid.";
}

/** An Admin-only operator retry. Scheduled reconciliation uses the separate internal route. */
export async function POST() {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  let config;
  try {
    config = getHubSpotConfig();
  } catch (error) {
    return NextResponse.json({ error: safeConfigurationMessage(error) }, { status: 422 });
  }

  try {
    const serviceClient = createServiceDatabaseClient();
    const repository = new SupabaseHubSpotSyncRepository(serviceClient);
    const result = await runHubSpotReconciliation({ source: new HubSpotClient(config), config, repository });
    await serviceClient.from("audit_events").insert({
      actor_profile_id: user.id,
      actor_email: user.email ?? null,
      area: "hubspot_sync",
      action: "insert",
      request_context: { trigger: "admin_manual_reconciliation", processed: result.processed, failed: result.failed },
    });
    return NextResponse.json(result);
  } catch (error) {
    // Errors emitted by this integration use safe, credential-free messages only.
    console.error("HubSpot manual sync failed:", error instanceof Error ? error.message : "Unknown failure");
    return NextResponse.json({ error: "HubSpot sync failed. Review Integration Errors for details." }, { status: 500 });
  }
}
