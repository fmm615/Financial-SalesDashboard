import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Returns open HubSpot duplicate candidates without exposing raw provider payloads. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { data: groups, error: groupsError } = await client.from("b2b_duplicate_groups")
    .select("id,created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (groupsError) return NextResponse.json({ error: "Could not load HubSpot duplicate candidates." }, { status: 500 });
  if (!groups?.length) return NextResponse.json({ groups: [] });

  const groupIds = groups.map((group) => group.id);
  const { data: members, error: membersError } = await client.from("b2b_duplicate_group_members")
    .select("group_id,deal_id")
    .in("group_id", groupIds);
  if (membersError) return NextResponse.json({ error: "Could not load HubSpot duplicate candidates." }, { status: 500 });

  const dealIds = [...new Set((members ?? []).map((member) => member.deal_id))];
  const { data: deals, error: dealsError } = await client.from("b2b_deals")
    .select("id,external_deal_id,name,stage_code,pipeline_amount_usd,original_currency,hubspot_close_date")
    .in("id", dealIds);
  if (dealsError) return NextResponse.json({ error: "Could not load HubSpot duplicate candidates." }, { status: 500 });

  const dealsById = new Map((deals ?? []).map((deal) => [deal.id, deal]));
  const membersByGroup = new Map<string, string[]>();
  for (const member of members ?? []) {
    membersByGroup.set(member.group_id, [...(membersByGroup.get(member.group_id) ?? []), member.deal_id]);
  }

  return NextResponse.json({
    groups: groups.map((group) => ({
      id: group.id,
      flaggedAt: group.created_at,
      deals: (membersByGroup.get(group.id) ?? []).map((dealId) => dealsById.get(dealId)).filter(Boolean),
    })).filter((group) => group.deals.length > 1),
  });
}
