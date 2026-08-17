import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cFinanceBulkCanonicalDecisionSchema } from "@/lib/validation/b2c-finance-action-contracts";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";

/** Saves one audited canonical decision per proven duplicate pair; no source evidence is changed. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = b2cFinanceBulkCanonicalDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance duplicate decision." }, { status: 422 });
  }

  try {
    const decidedGroups = await new B2cFinanceActionRepository(client).applyBulkCanonicalDecision(parsed.data);
    return NextResponse.json({ decidedGroups });
  } catch {
    return NextResponse.json({ error: "Could not save the B2C Finance duplicate decisions. No source data was changed." }, { status: 422 });
  }
}
