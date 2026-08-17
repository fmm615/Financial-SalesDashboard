import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseB2cFinanceLedgerRepository } from "@/server/repositories/b2c-finance-ledger-repository";

function safeFailureReference(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code.toUpperCase()
    : "UNKNOWN";
  return `FINANCE-POST-${/^[A-Z0-9]{1,20}$/.test(code) ? code : "UNKNOWN"}`;
}

/** Adds only already approved iOS/bank-transfer Finance rows through the protected database transaction. */
export async function POST(_request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  try {
    return NextResponse.json({ result: await new SupabaseB2cFinanceLedgerRepository(client).postApprovedFinancePayments() });
  } catch (error) {
    return NextResponse.json({ error: "Could not post approved B2C Finance payments.", reference: safeFailureReference(error) }, { status: 500 });
  }
}
