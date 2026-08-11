import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { operationalTargetSchema } from "@/lib/validation/target-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ targetId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = operationalTargetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid operational target revision." }, { status: 422 });

  const { targetId } = await params;
  const value = parsed.data;
  const { data: successorId, error } = await client.rpc("revise_operational_target", {
    p_target_id: targetId,
    p_display_name: value.displayName,
    p_value_kind: value.valueKind,
    p_target_value: value.targetValue,
    p_unit_label: value.unitLabel ?? null,
    p_period_start: value.periodStart,
    p_period_end: value.periodEnd,
    p_finance_reference: value.financeReference,
    p_revision_reason: value.revisionReason,
  });
  if (error || !successorId) return NextResponse.json({ error: "The operational target could not be revised." }, { status: 422 });
  return NextResponse.json({ targetId: successorId }, { status: 200 });
}
