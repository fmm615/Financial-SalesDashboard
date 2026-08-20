import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The shared record drawer's "Audit history" section. Both an Admin and a
 * Viewer may inspect audit history (see "One Owner Per Workflow" -- Ledger
 * inspection is not Admin-only), so this reads the already-approved-readable
 * `financial_corrections` table rather than the Admin-only `audit_events`
 * log. Every B2C correction/exception/FX/posted-adjustment write already
 * records itself here with the payment or refund id as `target_record_id`.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !(await getApprovedRole(client, user.id))) {
    return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C record." }, { status: 422 });
  }

  const { data, error } = await client
    .from("financial_corrections")
    .select("id,target_area,correction_type,before_value,after_value,reason,effective_on,created_at")
    .in("target_area", ["b2c_payment", "b2c_refund"])
    .eq("target_record_id", paymentId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Could not load B2C audit history." }, { status: 500 });

  return NextResponse.json({
    entries: (data ?? []).map((row) => ({
      id: row.id,
      area: row.target_area,
      correctionType: row.correction_type,
      beforeValue: row.before_value,
      afterValue: row.after_value,
      reason: row.reason,
      effectiveOn: row.effective_on,
      createdAt: row.created_at,
    })),
  });
}
