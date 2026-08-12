import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { financeImportRequestSchema } from "@/lib/validation/b2c-finance-import-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assessFinanceImport } from "@/server/services/b2c-finance-reconciliation";

/** Previews already-parsed Finance rows. It never accepts spreadsheet bytes or writes data. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = financeImportRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance import." }, { status: 422 });
  return NextResponse.json({ summary: assessFinanceImport(parsed.data).summary });
}
