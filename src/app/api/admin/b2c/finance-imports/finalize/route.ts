import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { financeImportRequestSchema } from "@/lib/validation/b2c-finance-import-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseB2cFinanceReconciliationRepository } from "@/server/repositories/b2c-finance-reconciliation-repository";
import { assessFinanceImport } from "@/server/services/b2c-finance-reconciliation";

/** Persists only already-parsed Finance rows through the atomic database function. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = financeImportRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance import." }, { status: 422 });

  try {
    const importId = await new SupabaseB2cFinanceReconciliationRepository(client)
      .finalizeFinanceImport(parsed.data, assessFinanceImport(parsed.data));
    return NextResponse.json({ importId }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "The B2C Finance import could not be saved." }, { status: 422 });
  }
}
