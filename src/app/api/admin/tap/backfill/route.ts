import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { TapClient } from "@/lib/integrations/tap/client";
import { getTapConfig } from "@/lib/integrations/tap/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseTapSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runTapHistoricalBackfillBatch } from "@/server/services/sync-tap";

export const runtime = "nodejs";
const backfillRequestSchema = z.object({ restartCompleted: z.boolean().optional() });

/** Starts/resumes a bounded, persisted, read-only Tap history import. */
export async function POST(request: NextRequest) {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const parsed = backfillRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid historical backfill request." }, { status: 422 });
  try {
    const config = getTapConfig();
    const serviceClient = createServiceDatabaseClient();
    const result = await runTapHistoricalBackfillBatch({ source: new TapClient(config), productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseTapSyncRepository(serviceClient), restartCompleted: parsed.data.restartCompleted });
    await serviceClient.from("audit_events").insert({ actor_profile_id: user.id, actor_email: user.email ?? null, area: "tap_historical_backfill", action: "insert", request_context: { run_id: result.runId, processed: result.processed, failed: result.failed, has_more: result.hasMore } });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tap historical backfill failed:", error instanceof Error ? error.message : "Unknown failure");
    return NextResponse.json({ error: "Tap historical backfill could not be completed. Review Tap integration errors." }, { status: 500 });
  }
}
