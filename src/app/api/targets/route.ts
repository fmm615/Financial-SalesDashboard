import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  const role = requireMiddlewareRole(request);
  if (!user || (role !== "admin" && role !== "viewer")) return NextResponse.json({ error: "Approved access is required." }, { status: 403 });

  const [financial, operational, progress] = await Promise.all([
    client.from("financial_targets").select("id,metric_code,period_start,period_end,target_amount_usd,status,finance_reference,revision_reason,created_at").in("status", ["draft", "active"]).order("period_start"),
    client.from("operational_targets").select("id,display_name,value_kind,target_value,unit_label,period_start,period_end,status,finance_reference,revision_reason,created_at").in("status", ["draft", "active"]).order("period_start"),
    client.from("operational_target_progress_updates").select("id,target_id,actual_value,effective_on,evidence_note,created_at").order("effective_on", { ascending: false }).order("created_at", { ascending: false }),
  ]);
  if (financial.error || operational.error || progress.error) return NextResponse.json({ error: "Could not load targets." }, { status: 500 });
  return NextResponse.json({ financialTargets: financial.data, operationalTargets: operational.data, operationalProgressUpdates: progress.data });
}
