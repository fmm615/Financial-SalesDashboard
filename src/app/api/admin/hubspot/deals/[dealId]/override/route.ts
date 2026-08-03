import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hubSpotDealLocalOverrideSchema } from "@/lib/validation/hubspot-review-contracts";
import { z } from "zod";

/** Saves an audited local deal override. HubSpot is read-only. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = hubSpotDealLocalOverrideSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid local override." }, { status: 422 });
  const { dealId } = await params;
  if (!z.string().uuid().safeParse(dealId).success) return NextResponse.json({ error: "Invalid HubSpot deal." }, { status: 422 });
  const { error } = await client.rpc("apply_hubspot_deal_local_override", {
    p_deal_id: dealId,
    p_name: parsed.data.name,
    p_owner_name: parsed.data.ownerName,
    p_stage_code: parsed.data.stageCode,
    p_amount: parsed.data.amount,
    p_currency: parsed.data.currency,
    p_exchange_rate_to_usd: parsed.data.exchangeRateToUsd,
    p_close_date: parsed.data.closeDate,
    p_renewal_date: parsed.data.renewalDate,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The local deal update could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
