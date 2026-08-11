import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { financialTargetSchema } from "@/lib/validation/target-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ targetId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const parsed = financialTargetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid financial target revision." }, { status: 422 });
  const { targetId } = await params;
  const value = parsed.data;
  const { data: successorId, error } = await client.rpc("revise_financial_target", { p_target_id: targetId, p_metric_code: value.metricCode, p_period_start: value.periodStart, p_period_end: value.periodEnd, p_target_amount_usd: value.targetAmountUsd, p_finance_reference: value.financeReference, p_revision_reason: value.revisionReason });
  if (error || !successorId) return NextResponse.json({ error: "The financial target could not be revised." }, { status: 422 });
  return NextResponse.json({ targetId: successorId }, { status: 200 });
}
