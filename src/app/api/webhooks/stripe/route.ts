import { NextResponse } from "next/server";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { isValidStripeSignature } from "@/lib/integrations/stripe/signature";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { parseStripeWebhookPayload, processStripeWebhook } from "@/server/services/sync-stripe";

export const runtime = "nodejs";

/** Stripe reaches this signature-validated endpoint; it never exposes provider data to the browser. */
export async function POST(request: Request) {
  let config;
  try { config = getStripeConfig(); } catch { return NextResponse.json({ error: "Stripe integration is unavailable." }, { status: 503 }); }
  const body = await request.text();
  if (!isValidStripeSignature({ payload: body, signature: request.headers.get("stripe-signature"), webhookSecret: config.webhookSecret })) {
    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 401 });
  }
  let event;
  try { event = parseStripeWebhookPayload(JSON.parse(body)); } catch { return NextResponse.json({ error: "Invalid Stripe webhook payload." }, { status: 400 }); }
  try {
    const result = await processStripeWebhook({ event, source: new StripeClient(config), productReferenceMetadataKey: config.productReferenceMetadataKey, repository: new SupabaseStripeSyncRepository(createServiceDatabaseClient()) });
    return NextResponse.json(result);
  } catch {
    // Stripe receives a retryable failure. Details are retained only as safe integration errors.
    return NextResponse.json({ error: "Stripe event processing failed." }, { status: 500 });
  }
}
