import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runStripeReconciliation } from "@/server/services/sync-stripe";

export const runtime = "nodejs";

/** An Admin-only on-demand retry; scheduled reconciliation uses the internal route. */
export async function POST() {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  let config;
  try { config = getStripeConfig(); } catch { return NextResponse.json({ error: "Stripe configuration is incomplete." }, { status: 422 }); }
  try {
    const serviceClient = createServiceDatabaseClient();
    const result = await runStripeReconciliation({ source: new StripeClient(config), productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseStripeSyncRepository(serviceClient) });
    await serviceClient.from("audit_events").insert({ actor_profile_id: user.id, actor_email: user.email ?? null, area: "stripe_sync", action: "insert", request_context: { trigger: "admin_manual_reconciliation", processed: result.processed, failed: result.failed, inserted: result.inserted } });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Stripe manual sync failed:", error instanceof Error ? error.message : "Unknown failure");
    return NextResponse.json({ error: "Stripe sync failed. Review Integration Errors for details." }, { status: 500 });
  }
}
