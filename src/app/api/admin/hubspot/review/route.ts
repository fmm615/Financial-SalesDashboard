import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Returns the Admin-only HubSpot review workload; provider raw payloads stay server-side. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const [dealsResult, flagsResult, errorsResult] = await Promise.all([
    client.from("b2b_deals")
      .select("id,name,stage_code,original_currency,hubspot_close_date,source_metadata,created_at")
      .eq("source_system", "hubspot")
      .eq("financial_status", "needs_review")
      .order("created_at", { ascending: false }),
    client.from("review_flags")
      .select("source_record_id,reason,priority,created_at")
      .eq("source_area", "b2b_deal")
      .eq("flag_type", "needs_follow_up")
      .eq("status", "open"),
    client.from("integration_errors")
      .select("id,safe_error_summary,occurred_at")
      .eq("provider", "hubspot")
      .is("resolved_at", null)
      .order("occurred_at", { ascending: false }),
  ]);

  const error = dealsResult.error ?? flagsResult.error ?? errorsResult.error;
  if (error) return NextResponse.json({ error: "Could not load HubSpot review items." }, { status: 500 });

  const flagsByDeal = new Map((flagsResult.data ?? []).map((flag) => [flag.source_record_id, flag]));
  return NextResponse.json({
    incompleteDeals: (dealsResult.data ?? []).map((deal) => ({
      id: deal.id,
      name: deal.name,
      stageCode: deal.stage_code,
      originalCurrency: deal.original_currency,
      closeDate: deal.hubspot_close_date,
      reason: flagsByDeal.get(deal.id)?.reason ?? "HubSpot financial data is incomplete.",
      flaggedAt: flagsByDeal.get(deal.id)?.created_at ?? deal.created_at,
    })),
    integrationErrors: errorsResult.data ?? [],
  });
}
