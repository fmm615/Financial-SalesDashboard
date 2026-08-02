import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hubSpotDealCorrectionSchema } from "@/lib/validation/hubspot-review-contracts";

export async function POST(request: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = hubSpotDealCorrectionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid correction." }, { status: 422 });

  const { dealId } = await params;
  const { error } = await client.rpc("apply_hubspot_deal_financial_correction", {
    p_deal_id: dealId,
    p_amount: parsed.data.amount,
    p_currency: parsed.data.currency,
    p_exchange_rate_to_usd: parsed.data.exchangeRateToUsd,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The HubSpot correction could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
