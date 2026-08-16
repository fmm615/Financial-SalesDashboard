import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { IntegrationRunSummaryRepository } from "@/server/repositories/integration-run-summary-repository";

/** Returns safe, persisted local backfill progress; it never calls a provider. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();

  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  try {
    return NextResponse.json({ summaries: await new IntegrationRunSummaryRepository(client).listLatestHistoricalBackfills() });
  } catch {
    return NextResponse.json({ error: "Could not load saved integration run summaries." }, { status: 500 });
  }
}
