import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseB2cFinanceReconciliationRepository } from "@/server/repositories/b2c-finance-reconciliation-repository";

/** Returns only safe B2C reconciliation coverage; raw source records stay Admin-only. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  const role = user ? await getApprovedRole(client, user.id) : null;
  if (!role) {
    return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  }
  try {
    const repository = new SupabaseB2cFinanceReconciliationRepository(client);
    const summary = await repository.getSafeSummary();
    // Only an Admin ever uploads a replacement workbook, and only an Admin can read this id under RLS.
    const latestCompletedPaymentTrackerImportId = role === "admin" ? await repository.getLatestCompletedPaymentTrackerImportId() : null;
    return NextResponse.json({ summary: { ...summary, latestCompletedPaymentTrackerImportId } });
  } catch {
    return NextResponse.json({ error: "Could not load the B2C reconciliation summary." }, { status: 500 });
  }
}
