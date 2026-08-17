import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cFinanceDateAuthoritySchema } from "@/lib/validation/b2c-finance-action-contracts";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";

/** Confirms a valid source Date over conflicting Month/Year labels without editing the workbook. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const parsed = b2cFinanceDateAuthoritySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance Date decision." }, { status: 422 });

  try {
    const resolvedRows = await new B2cFinanceActionRepository(client).applyDateAuthority(parsed.data);
    return NextResponse.json({ resolvedRows });
  } catch {
    return NextResponse.json({ error: "Could not confirm the B2C Finance dates. No source data was changed." }, { status: 422 });
  }
}
