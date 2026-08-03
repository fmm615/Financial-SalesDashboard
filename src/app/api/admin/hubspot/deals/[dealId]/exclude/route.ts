import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hubSpotDealExclusionSchema } from "@/lib/validation/hubspot-review-contracts";
import { z } from "zod";

/** Excludes a source deal locally with an audit reason; it never deletes HubSpot data. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = hubSpotDealExclusionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid exclusion." }, { status: 422 });
  const { dealId } = await params;
  if (!z.string().uuid().safeParse(dealId).success) return NextResponse.json({ error: "Invalid HubSpot deal." }, { status: 422 });
  const { error } = await client.rpc("exclude_hubspot_deal_locally", { p_deal_id: dealId, p_reason: parsed.data.reason });
  if (error) return NextResponse.json({ error: "The HubSpot deal could not be excluded locally." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
