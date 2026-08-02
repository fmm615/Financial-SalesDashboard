import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { HubSpotClient } from "@/lib/integrations/hubspot/client";
import { getHubSpotConfig } from "@/lib/integrations/hubspot/config";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";
import { runHubSpotReconciliation } from "@/server/services/sync-hubspot";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.INTEGRATION_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Server-to-server endpoint for the mandatory daily 48-hour HubSpot reconciliation. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const config = getHubSpotConfig();
    const repository = new SupabaseHubSpotSyncRepository(createServiceDatabaseClient());
    const result = await runHubSpotReconciliation({ source: new HubSpotClient(config), config, repository });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "HubSpot reconciliation failed. Review Integration Errors for details." }, { status: 500 });
  }
}
