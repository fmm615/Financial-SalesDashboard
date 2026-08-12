import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { reconciliationDecisionRequestSchema } from "@/lib/validation/b2c-finance-import-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** An Admin selects one Finance row or excludes a group; the database trigger audits and locks the decision. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { groupId } = await params;
  if (!z.string().uuid().safeParse(groupId).success) {
    return NextResponse.json({ error: "Invalid B2C reconciliation group." }, { status: 422 });
  }
  const parsed = reconciliationDecisionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C reconciliation decision." }, { status: 422 });

  const { data, error } = await client.from("b2c_reconciliation_decisions").insert({
    reconciliation_group_id: groupId,
    decision_state: parsed.data.decisionState,
    canonical_finance_row_id: parsed.data.canonicalFinanceRowId ?? null,
    decision_reason: parsed.data.decisionReason,
  }).select("id").single();
  if (error || !data) return NextResponse.json({ error: "The B2C reconciliation decision could not be saved." }, { status: 422 });
  return NextResponse.json({ decisionId: data.id }, { status: 201 });
}
