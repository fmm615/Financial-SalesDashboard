import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { TapClient } from "@/lib/integrations/tap/client";
import { getTapConfig } from "@/lib/integrations/tap/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseTapSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runTapReconciliation } from "@/server/services/sync-tap";

export const runtime = "nodejs";

/** Admin-only on-demand Tap read reconciliation. The Tap client has no write methods. */
export async function POST() {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  let config;
  try { config = getTapConfig(); } catch { return NextResponse.json({ error: "Tap configuration is incomplete." }, { status: 422 }); }
  try {
    const serviceClient = createServiceDatabaseClient();
    const result = await runTapReconciliation({ source: new TapClient(config), productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseTapSyncRepository(serviceClient) });
    await serviceClient.from("audit_events").insert({ actor_profile_id: user.id, actor_email: user.email ?? null, area: "tap_sync", action: "insert", request_context: { trigger: "admin_manual_reconciliation", processed: result.processed, failed: result.failed, inserted: result.inserted } });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tap manual sync failed:", error instanceof Error ? error.message : "Unknown failure");
    return NextResponse.json({ error: "Tap sync failed. Review Integration Errors for details." }, { status: 500 });
  }
}
