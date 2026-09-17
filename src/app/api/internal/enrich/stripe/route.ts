import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runStripeEnrichmentRefresh } from "@/server/services/sync-stripe";

export const runtime = "nodejs";
export const maxDuration = 300;

const ENRICHMENT_REFRESH_WINDOW_DAYS = 90;

function matchesSecret(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Accepts this app's own cron secret (matching the existing reconciliation route) or Vercel's own CRON_SECRET convention, so a Vercel Cron entry authorizes without extra configuration. */
function isAuthorized(request: Request): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return matchesSecret(process.env.INTEGRATION_CRON_SECRET, supplied) || matchesSecret(process.env.CRON_SECRET, supplied);
}

/**
 * Server-to-server endpoint for the daily Stripe enrichment refresh. Unlike
 * the mandatory 48-hour reconciliation (which discovers charges Stripe
 * created recently), this re-checks payments PLAYBOOK already has -- within
 * the last 90 days by default -- purely to catch a Stripe profile or
 * payment-method update that happened after the original import. Pass
 * `?since=all` once for a full-history catch-up; the daily schedule should
 * always call it with no query string.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const sinceAll = new URL(request.url).searchParams.get("since") === "all";
  try {
    const config = getStripeConfig();
    const now = new Date();
    const sinceDate = sinceAll ? null : new Date(now.getTime() - ENRICHMENT_REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const result = await runStripeEnrichmentRefresh({
      source: new StripeClient(config),
      productReferenceMetadataKey: config.productReferenceMetadataKey,
      repository: new SupabaseStripeSyncRepository(createServiceDatabaseClient()),
      sinceDate,
      now,
    });
    return NextResponse.json(result);
  } catch { return NextResponse.json({ error: "Stripe enrichment refresh failed. Review Integration Errors for details." }, { status: 500 }); }
}
