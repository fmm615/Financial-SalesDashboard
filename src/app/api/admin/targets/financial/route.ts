import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { financialTargetSchema } from "@/lib/validation/target-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const parsed = financialTargetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid financial target." }, { status: 422 });
  const { data, error } = await client.from("financial_targets").insert({
    metric_code: parsed.data.metricCode, period_start: parsed.data.periodStart, period_end: parsed.data.periodEnd,
    target_amount_usd: parsed.data.targetAmountUsd, status: parsed.data.status,
    finance_reference: parsed.data.financeReference, revision_reason: parsed.data.revisionReason,
  }).select("id").single();
  if (error) return NextResponse.json({ error: "The financial target could not be saved." }, { status: 422 });
  return NextResponse.json({ targetId: data.id }, { status: 201 });
}

