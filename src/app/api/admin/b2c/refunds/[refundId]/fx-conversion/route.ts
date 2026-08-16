import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { b2cFxConversionSchema } from "@/lib/validation/b2c-review-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Records an append-only Finance refund conversion locally. It never calls Tap or Stripe. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ refundId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { refundId } = await params;
  if (!z.string().uuid().safeParse(refundId).success) {
    return NextResponse.json({ error: "Invalid B2C refund." }, { status: 422 });
  }
  const parsed = b2cFxConversionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid Finance conversion." }, { status: 422 });
  }

  const { data, error } = await client.rpc("record_b2c_refund_fx_conversion", {
    p_refund_id: refundId,
    p_exchange_rate_to_usd: parsed.data.exchangeRateToUsd,
    p_conversion_source: parsed.data.conversionSource,
    p_effective_on: parsed.data.effectiveOn,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The Finance USD refund conversion could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true, amountUsd: data });
}
