import { NextResponse } from "next/server";
import { HubSpotClient } from "@/lib/integrations/hubspot/client";
import { getHubSpotConfig } from "@/lib/integrations/hubspot/config";
import { isValidHubSpotSignature } from "@/lib/integrations/hubspot/signature";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseHubSpotSyncRepository } from "@/server/repositories/hubspot-sync-repository";
import { parseHubSpotWebhookPayload, processHubSpotWebhook } from "@/server/services/sync-hubspot";

export const runtime = "nodejs";

/** HubSpot posts only to this signature-validated, unauthenticated endpoint. */
export async function POST(request: Request) {
  let config;
  try {
    config = getHubSpotConfig();
  } catch {
    return NextResponse.json({ error: "HubSpot integration is unavailable." }, { status: 503 });
  }
  if (!config.webhookClientSecret) {
    return NextResponse.json({ error: "HubSpot webhook validation is unavailable." }, { status: 503 });
  }

  const body = await request.text();
  const valid = isValidHubSpotSignature({
    clientSecret: config.webhookClientSecret,
    method: request.method,
    url: config.webhookCallbackUrl ?? request.url,
    body,
    signature: request.headers.get("x-hubspot-signature-v3"),
    timestamp: request.headers.get("x-hubspot-request-timestamp"),
  });
  if (!valid) return NextResponse.json({ error: "Invalid HubSpot signature." }, { status: 401 });

  let events;
  try {
    events = parseHubSpotWebhookPayload(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: "Invalid HubSpot webhook payload." }, { status: 400 });
  }

  try {
    const repository = new SupabaseHubSpotSyncRepository(createServiceDatabaseClient());
    const result = await processHubSpotWebhook({
      events,
      source: new HubSpotClient(config),
      config,
      repository,
    });
    return NextResponse.json(result);
  } catch {
    // HubSpot receives a retryable failure; details are only persisted as safe integration errors.
    return NextResponse.json({ error: "HubSpot event processing failed." }, { status: 500 });
  }
}
