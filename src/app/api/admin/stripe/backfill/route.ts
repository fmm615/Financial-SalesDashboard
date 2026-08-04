import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runStripeHistoricalBackfillBatch } from "@/server/services/sync-stripe";

export const runtime = "nodejs";

const backfillRequestSchema = z.object({ restartCompleted: z.boolean().optional() });

/** Starts or resumes one bounded, read-only page of the all-history Stripe import. */
export async function POST(request: NextRequest) {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await sessionClient.auth.getUser();
  if (!user || await getApprovedRole(sessionClient, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = backfillRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid historical backfill request." }, { status: 422 });

  try {
    const config = getStripeConfig();
    const serviceClient = createServiceDatabaseClient();
    const result = await runStripeHistoricalBackfillBatch({
      source: new StripeClient(config),
      productReferenceMetadataKey: config.productReferenceMetadataKey,
      repository: new SupabaseStripeSyncRepository(serviceClient),
      restartCompleted: parsed.data.restartCompleted,
    });
    await serviceClient.from("audit_events").insert({
      actor_profile_id: user.id,
      actor_email: user.email ?? null,
      area: "stripe_historical_backfill",
      action: "insert",
      request_context: { run_id: result.runId, processed: result.processed, failed: result.failed, has_more: result.hasMore },
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Stripe historical backfill failed:", error instanceof Error ? error.message : "Unknown failure");
    return NextResponse.json({ error: "Stripe historical backfill could not be completed. Review Stripe integration errors." }, { status: 500 });
  }
}
