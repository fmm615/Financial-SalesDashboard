import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { StripeClient } from "@/lib/integrations/stripe/client";
import { getStripeConfig } from "@/lib/integrations/stripe/config";
import { createServerSupabaseClient, createServiceDatabaseClient } from "@/lib/supabase/server";
import { SupabaseStripeSyncRepository } from "@/server/repositories/stripe-sync-repository";
import { refreshStripePaymentEnrichment } from "@/server/services/sync-stripe";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Re-fetches one payment's Stripe charge and enrichment right now. Never
 * changes b2c_payments.customer_email/name/phone (the immutable, authoritative
 * charge-level fields) or reportability -- it only refreshes the same
 * optional evidence (checkout/invoice/payment-method/customer-profile/
 * settlement) already collected at import time, through the identical
 * persistCharge + persistStripeDetails path.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const sessionClient = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(sessionClient);
  if (!user || requireMiddlewareRole(request) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }

  try {
    const config = getStripeConfig();
    const serviceClient = createServiceDatabaseClient();
    const result = await refreshStripePaymentEnrichment({
      paymentId,
      source: new StripeClient(config),
      productReferenceMetadataKey: config.productReferenceMetadataKey,
      repository: new SupabaseStripeSyncRepository(serviceClient),
    });
    if (!result.refreshed) return NextResponse.json({ error: "This is not a Stripe payment, or it no longer exists." }, { status: 404 });

    await serviceClient.from("audit_events").insert({
      actor_profile_id: user.id,
      actor_email: user.email ?? null,
      area: "b2c_stripe_enrichment_refresh",
      record_id: paymentId,
      action: "update",
      after_value: { refreshed: true },
      request_context: { payment_id: paymentId },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not refresh this payment's Stripe evidence." }, { status: 500 });
  }
}
