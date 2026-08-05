import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { b2cPaymentLocalCorrectionSchema } from "@/lib/validation/b2c-review-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Records a verified local overlay and never sends a request to Stripe. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }
  const parsed = b2cPaymentLocalCorrectionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C correction." }, { status: 422 });
  }

  const { error } = await client.rpc("apply_b2c_payment_local_correction", {
    p_payment_id: paymentId,
    p_customer_name: parsed.data.customerName ?? null,
    p_customer_email: parsed.data.customerEmail ?? null,
    p_customer_phone: parsed.data.customerPhone ?? null,
    p_category_code: parsed.data.categoryCode ?? null,
    p_membership_tier: parsed.data.membershipTier ?? null,
    p_local_amount_usd: parsed.data.amountUsd ?? null,
    p_local_occurred_on: parsed.data.occurredOn ?? null,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The local B2C correction could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
