import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { B2cExactDuplicateReconciliationRepository } from "@/server/repositories/b2c-exact-duplicate-reconciliation-repository";

/** Invokes the database-enforced grouping run; it never decides or publishes a Finance row. */
export async function POST(_request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const createdGroups = await new B2cExactDuplicateReconciliationRepository(client).createExactDuplicateGroups();
    return NextResponse.json({ createdGroups });
  } catch {
    return NextResponse.json({ error: "Could not create exact B2C Finance duplicate groups." }, { status: 422 });
  }
}
