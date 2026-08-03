import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hubSpotCloseDateCorrectionSchema } from "@/lib/validation/hubspot-review-contracts";

/** Records a local Admin close-date correction and never writes to HubSpot. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = hubSpotCloseDateCorrectionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid close-date correction." }, { status: 422 });

  const { dealId } = await params;
  const { error } = await client.rpc("apply_hubspot_deal_close_date_correction", {
    p_deal_id: dealId,
    p_close_date: parsed.data.closeDate,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The HubSpot close-date correction could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
