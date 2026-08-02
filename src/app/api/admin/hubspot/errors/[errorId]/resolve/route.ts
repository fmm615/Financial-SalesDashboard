import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hubSpotErrorResolutionSchema } from "@/lib/validation/hubspot-review-contracts";

export async function POST(request: NextRequest, { params }: { params: Promise<{ errorId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = hubSpotErrorResolutionSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid resolution." }, { status: 422 });

  const { errorId } = await params;
  const { error } = await client.rpc("resolve_hubspot_integration_error", {
    p_error_id: errorId,
    p_resolution_note: parsed.data.resolutionNote,
  });
  if (error) return NextResponse.json({ error: "The HubSpot issue could not be resolved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
