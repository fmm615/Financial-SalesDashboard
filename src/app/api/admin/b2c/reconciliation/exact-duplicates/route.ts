import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { B2cExactDuplicateReconciliationRepository } from "@/server/repositories/b2c-exact-duplicate-reconciliation-repository";
import { toAdminExactDuplicateGroups } from "@/server/services/b2c-exact-duplicate-review";

/** Admin-only source rows for exact Finance duplicate review; no Viewer route exposes these records. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const rows = await new B2cExactDuplicateReconciliationRepository(client).listPendingExactDuplicateGroups();
    return NextResponse.json({ groups: toAdminExactDuplicateGroups(rows) });
  } catch {
    return NextResponse.json({ error: "Could not load exact B2C Finance duplicate groups." }, { status: 500 });
  }
}
