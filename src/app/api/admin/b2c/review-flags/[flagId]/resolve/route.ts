import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { b2cReviewResolutionSchema } from "@/lib/validation/b2c-review-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Resolves a local B2C review task with an auditable Admin note; Stripe is untouched. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ flagId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const { flagId } = await params;
  if (!z.string().uuid().safeParse(flagId).success) return NextResponse.json({ error: "Invalid B2C review item." }, { status: 422 });
  const parsed = b2cReviewResolutionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid resolution." }, { status: 422 });
  const { error } = await client.rpc("resolve_b2c_review_flag", {
    p_flag_id: flagId,
    p_resolution_status: parsed.data.resolutionStatus,
    p_resolution_note: parsed.data.resolutionNote,
  });
  if (error) return NextResponse.json({ error: "The B2C review item could not be resolved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
