import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { HubSpotClient } from "@/lib/integrations/hubspot/client";
import { getHubSpotConfig } from "@/lib/integrations/hubspot/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";
import { runHubSpotReconciliation } from "@/server/services/sync-hubspot";

export const runtime = "nodejs";

/** An Admin-only operator retry. Scheduled reconciliation uses the separate internal route. */
export async function POST() {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  try {
    const config = getHubSpotConfig();
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
  } catch {
    return NextResponse.json({ error: "HubSpot sync failed. Review Integration Errors for details." }, { status: 500 });
  }
}
