import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole, getSessionUser } from "@/lib/auth/access";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runStripeHistoricalBackfillBatch } from "@/server/services/sync-stripe";

export const runtime = "nodejs";
// Each batch does per-charge Stripe enrichment lookups sequentially; give it
// the full 60s a Vercel serverless function can run so a busy page doesn't
// get killed mid-request and return an HTML error page instead of JSON.
export const maxDuration = 60;

const backfillRequestSchema = z.object({ restartCompleted: z.boolean().optional() });

/** Starts or resumes one bounded, read-only page of the all-history Stripe import. */
export async function POST(request: NextRequest) {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(sessionClient);
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
      after_value: { run_id: result.runId, processed: result.processed, failed: result.failed },
      request_context: { run_id: result.runId, processed: result.processed, failed: result.failed, has_more: result.hasMore },
    });
    return NextResponse.json(result);
  } catch (error) {
    let cause = "";
    if (error instanceof Error && error.cause) {
      const c = error.cause;
      cause = c instanceof AggregateError
        ? ` Cause: AggregateError[${c.errors.map((e) => (e instanceof Error ? `${e.name}:${e.message}` : String(e))).join(" | ")}]`
        : ` Cause: ${c instanceof Error ? `${c.name}:${c.message}` : String(c)}`;
    }
    console.error("Stripe historical backfill failed:", (error instanceof Error ? error.message : "Unknown failure") + cause);
    return NextResponse.json({ error: "Stripe historical backfill could not be completed. Review Stripe integration errors." }, { status: 500 });
  }
}
