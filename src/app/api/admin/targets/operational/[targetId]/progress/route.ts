import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { operationalProgressSchema } from "@/lib/validation/target-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseTargetRepository } from "@/server/repositories/target-repository";
import { recordOperationalProgress } from "@/server/services/target-management";

export async function POST(request: NextRequest, { params }: { params: Promise<{ targetId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const { targetId } = await params;
  const parsed = operationalProgressSchema.safeParse({ ...(body && typeof body === "object" ? body : {}), targetId });
  if (!parsed.success) return NextResponse.json({ error: "Invalid operational progress update." }, { status: 422 });
  try {
    const progress = await recordOperationalProgress(parsed.data, new SupabaseTargetRepository(client));
    return NextResponse.json({ progress }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "The operational progress update could not be saved." }, { status: 422 });
  }
}

