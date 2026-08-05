import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { b2cFinanceExceptionSchema } from "@/lib/validation/b2c-review-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Includes a succeeded payment locally only after the Admin makes both required attestations. Stripe is never called. */
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
  const parsed = b2cFinanceExceptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid Finance exception." }, { status: 422 });
  }
  const { error } = await client.rpc("include_b2c_payment_with_finance_exception", {
    p_payment_id: paymentId,
    p_reason: parsed.data.reason,
    p_confirmed_provider_transaction: parsed.data.confirmedProviderTransaction,
    p_confirmed_no_known_duplicate: parsed.data.confirmedNoKnownDuplicate,
  });
  if (error) return NextResponse.json({ error: "The Finance exception could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
