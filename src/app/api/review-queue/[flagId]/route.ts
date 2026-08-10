import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { reviewQueueFlagIdSchema } from "@/lib/validation/review-queue-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseReviewQueueRepository } from "@/server/repositories/review-queue-repository";
import { createReviewQueueService } from "@/server/services/review-queue";

/** Returns retained review history for one approved-user-visible flag. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ flagId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !await getApprovedRole(client, user.id)) {
    return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  }

  const { flagId } = await params;
  if (!reviewQueueFlagIdSchema.safeParse(flagId).success) {
    return NextResponse.json({ error: "Invalid review queue item." }, { status: 422 });
  }

  try {
    const item = await createReviewQueueService(new SupabaseReviewQueueRepository(client)).detail(flagId);
    if (!item) return NextResponse.json({ error: "Review queue item was not found." }, { status: 404 });
    return NextResponse.json({ item });
  } catch {
    return NextResponse.json({ error: "Could not load review queue item." }, { status: 500 });
  }
}
