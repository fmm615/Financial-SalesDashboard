import { NextResponse } from "next/server";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { B2cExactDuplicateReconciliationRepository } from "@/server/repositories/b2c-exact-duplicate-reconciliation-repository";
import { toAdminExactDuplicateGroups } from "@/server/services/b2c-exact-duplicate-review";

/** Admin-only source rows for exact Finance duplicate review; no Viewer route exposes these records. */
export async function GET(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const hasGroupId = request.nextUrl.searchParams.has("groupId");
  const groupId = request.nextUrl.searchParams.get("groupId");
  if (hasGroupId && !z.string().uuid().safeParse(groupId).success) {
    return NextResponse.json({ error: "Invalid B2C reconciliation group." }, { status: 422 });
  }
  try {
    const repository = new B2cExactDuplicateReconciliationRepository(client);
    const rows = hasGroupId
      ? await repository.getPendingExactDuplicateGroup(groupId as string).then((group) => group ? [group] : [])
      : await repository.listPendingExactDuplicateGroups();
    return NextResponse.json({ groups: toAdminExactDuplicateGroups(rows) });
  } catch {
    return NextResponse.json({ error: "Could not load exact B2C Finance duplicate groups." }, { status: 500 });
  }
}
