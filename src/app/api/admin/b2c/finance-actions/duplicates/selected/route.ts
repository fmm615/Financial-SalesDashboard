import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cFinanceSelectedDuplicateDecisionSchema } from "@/lib/validation/b2c-finance-action-contracts";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";

/** Records every selected B2C Finance duplicate choice together, without altering source evidence. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = b2cFinanceSelectedDuplicateDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid selected B2C Finance duplicate decisions." }, { status: 422 });
  }

  try {
    const decidedGroups = await new B2cFinanceActionRepository(client).applySelectedDuplicateDecisions(parsed.data);
    return NextResponse.json({ decidedGroups });
  } catch {
    return NextResponse.json({ error: "Could not save the selected B2C Finance duplicate decisions. No source data was changed." }, { status: 422 });
  }
}
