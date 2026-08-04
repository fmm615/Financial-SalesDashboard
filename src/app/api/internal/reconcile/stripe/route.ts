import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { runStripeReconciliation } from "@/server/services/sync-stripe";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.INTEGRATION_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Server-to-server endpoint for the mandatory daily Stripe 48-hour reconciliation. */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const config = getStripeConfig();
    const result = await runStripeReconciliation({ source: new StripeClient(config), productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseStripeSyncRepository(createServiceDatabaseClient()) });
    return NextResponse.json(result);
  } catch { return NextResponse.json({ error: "Stripe reconciliation failed. Review Integration Errors for details." }, { status: 500 }); }
}
