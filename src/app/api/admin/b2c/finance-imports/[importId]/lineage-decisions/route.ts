import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { financeLineageDecisionSchema } from "@/lib/validation/b2c-finance-lineage-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * An Admin resolves one version-diff candidate at a time. The database trigger
 * locks the candidate, rejects a second conflicting decision, and performs the
 * resulting lineage link; leaving a candidate undecided performs no write.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ importId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { importId } = await params;
  if (!z.string().uuid().safeParse(importId).success) {
    return NextResponse.json({ error: "Invalid B2C Finance import." }, { status: 422 });
  }
  const parsed = financeLineageDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance lineage decision." }, { status: 422 });

  const { data, error } = await client.from("b2c_finance_import_version_decisions").insert({
    import_id: importId,
    candidate_id: parsed.data.candidateId,
    decision: parsed.data.decision,
    target_lineage_id: parsed.data.targetLineageId ?? null,
    target_payment_id: parsed.data.targetPaymentId ?? null,
    reason: parsed.data.reason,
  }).select("id").single();
  if (error || !data) return NextResponse.json({ error: "The B2C Finance lineage decision could not be saved." }, { status: 422 });
  return NextResponse.json({ decisionId: data.id }, { status: 201 });
}
