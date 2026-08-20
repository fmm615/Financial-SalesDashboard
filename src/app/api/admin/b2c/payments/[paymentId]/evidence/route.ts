import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getB2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

/**
 * The Admin-only full-evidence read the shared record drawer's source
 * evidence panel uses. `/api/b2c/workspace` (Task 3) deliberately strips
 * `stripeEvidence` from every row so a Viewer-safe response never carries
 * Admin-only provider evidence; this route is that dedicated Admin read,
 * gated the same way every other Admin-only B2C route is gated. It reuses
 * `getB2cDashboardSnapshot` -- the one source read for B2C payments -- rather
 * than duplicating its Stripe evidence query.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }

  try {
    const snapshot = await getB2cDashboardSnapshot(client, new Date(), "all");
    const row = snapshot.rows.find((candidate) => candidate.id === paymentId && candidate.recordType === "Payment");
    if (!row) return NextResponse.json({ error: "This B2C payment is unavailable." }, { status: 404 });
    return NextResponse.json({
      paymentId: row.id,
      source: row.source,
      sourceSystem: row.sourceSystem,
      providerReference: row.providerReference,
      date: row.date,
      stripeEvidence: row.sourceSystem === "stripe" ? row.stripeEvidence ?? null : null,
    });
  } catch {
    return NextResponse.json({ error: "Could not load B2C source evidence." }, { status: 500 });
  }
}
