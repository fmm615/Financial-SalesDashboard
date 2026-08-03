import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hubSpotDuplicateResolutionSchema } from "@/lib/validation/hubspot-review-contracts";

export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { groupId } = await params;
  const parsed = hubSpotDuplicateResolutionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid duplicate decision." }, { status: 422 });

  const { error } = await client.rpc("resolve_hubspot_duplicate_group", {
    p_group_id: groupId,
    p_decision: parsed.data.decision,
    p_keep_deal_id: parsed.data.keepDealId ?? null,
    p_note: parsed.data.resolutionNote,
  });
  if (error) return NextResponse.json({ error: "The duplicate decision could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
