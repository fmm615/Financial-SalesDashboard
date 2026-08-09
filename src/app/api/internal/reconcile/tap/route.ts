import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { TapClient } from "@/lib/integrations/tap/client";
import { getTapConfig } from "@/lib/integrations/tap/config";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseTapSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runTapReconciliation } from "@/server/services/sync-tap";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.INTEGRATION_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Server-to-server endpoint for the mandatory daily Tap 48-hour reconciliation. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const config = getTapConfig();
    return NextResponse.json(await runTapReconciliation({ source: new TapClient(config), productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseTapSyncRepository(createServiceDatabaseClient()) }));
  } catch { return NextResponse.json({ error: "Tap reconciliation failed. Review Integration Errors for details." }, { status: 500 }); }
}
