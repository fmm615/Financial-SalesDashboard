import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { reviewQueueListQuerySchema } from "@/lib/validation/review-queue-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseReviewQueueRepository } from "@/server/repositories/review-queue-repository";
import { createReviewQueueService } from "@/server/services/review-queue";

function validationErrorMessage(issue: { path: PropertyKey[]; message: string } | undefined): string {
  if (!issue) return "Invalid review queue filters.";
  const field = issue.path[0] === "priority" ? "Priority" : "Review queue";
  return `${field}: ${issue.message}`;
}

/** Returns approved-user-visible review metadata; source values remain in their bounded workflows. */
export async function GET(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  const role = requireMiddlewareRole(request);
  if (!user || (role !== "admin" && role !== "viewer")) {
    return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  }

  const parsed = reviewQueueListQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: validationErrorMessage(parsed.error.issues[0]) }, { status: 422 });

  try {
    return NextResponse.json(await createReviewQueueService(new SupabaseReviewQueueRepository(client)).list(parsed.data));
  } catch {
    return NextResponse.json({ error: "Could not load review queue." }, { status: 500 });
  }
}
