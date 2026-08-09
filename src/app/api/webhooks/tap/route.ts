import { NextResponse } from "next/server";
import { getTapConfig } from "@/lib/integrations/tap/config";
import { isValidTapWebhookSignature } from "@/lib/integrations/tap/signature";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseTapSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { processTapWebhook } from "@/server/services/sync-tap";

export const runtime = "nodejs";

/** Tap posts signed captured/failed charge data; PLAYBOOK never calls Tap from this route. */
export async function POST(request: Request) {
  let config;
  try { config = getTapConfig(); } catch { return NextResponse.json({ error: "Tap integration is unavailable." }, { status: 503 }); }
  const body = await request.text();
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return NextResponse.json({ error: "Invalid Tap webhook payload." }, { status: 400 }); }
  if (!isValidTapWebhookSignature({ payload, signature: request.headers.get("hashstring"), secretApiKey: config.apiKey })) {
    return NextResponse.json({ error: "Invalid Tap signature." }, { status: 401 });
  }
  try {
    const result = await processTapWebhook({ payload, productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseTapSyncRepository(createServiceDatabaseClient()) });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Tap event processing failed." }, { status: 500 });
  }
}
