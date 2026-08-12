import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseB2cFinanceReconciliationRepository } from "@/server/repositories/b2c-finance-reconciliation-repository";

/** Returns only safe B2C reconciliation coverage; raw source records stay Admin-only. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !await getApprovedRole(client, user.id)) {
    return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  }
  try {
    return NextResponse.json({ summary: await new SupabaseB2cFinanceReconciliationRepository(client).getSafeSummary() });
  } catch {
    return NextResponse.json({ error: "Could not load the B2C reconciliation summary." }, { status: 500 });
  }
}
