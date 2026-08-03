import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manualB2bDealSchema } from "@/lib/validation/financial-contracts";

/** Creates a Finance-entered B2B deal locally. HubSpot is never called or changed. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = manualB2bDealSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid manual B2B deal." }, { status: 422 });
  }

  const value = parsed.data;
  const { data: dealId, error } = await client.rpc("create_manual_b2b_deal", {
    p_company_name: value.companyName,
    p_name: value.name,
    p_owner_name: value.ownerName,
    p_stage_code: value.stageCode,
    p_original_amount: value.pipelineOriginalAmount,
    p_original_currency: value.originalCurrency,
    p_exchange_rate_to_usd: value.exchangeRateToUsd,
    p_close_date: value.closeDate,
    p_renewal_date: value.renewalDate,
    p_reason: value.manualEntryReason,
  });
  if (error || !dealId) {
    return NextResponse.json({ error: "The manual B2B deal could not be saved." }, { status: 422 });
  }
  return NextResponse.json({ dealId });
}
