import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { reviewQueueFlagIdSchema, reviewQueueNoteSchema } from "@/lib/validation/review-queue-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseReviewQueueRepository } from "@/server/repositories/review-queue-repository";

/** Saves an append-only review note. The database trigger records the authenticated Admin actor. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ flagId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { flagId } = await params;
  if (!reviewQueueFlagIdSchema.safeParse(flagId).success) {
    return NextResponse.json({ error: "Invalid review queue item." }, { status: 422 });
  }
  const parsed = reviewQueueNoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid review note." }, { status: 422 });

  try {
    const saved = await new SupabaseReviewQueueRepository(client).addNote(flagId, parsed.data.note);
    if (!saved) return NextResponse.json({ error: "Review queue item was not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not save review note." }, { status: 500 });
  }
}
