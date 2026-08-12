import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSinglePaymentTrackerFile, paymentTrackerFinalizeSchema } from "@/lib/validation/payment-tracker-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizePaymentTrackerUpload } from "@/server/services/payment-tracker-upload";

export const runtime = "nodejs";

/** Re-checks the reviewed file and stages it only after private Storage succeeds. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const formData = await request.formData();
    const parsed = paymentTrackerFinalizeSchema.safeParse({ expectedFileSha256: formData.get("expectedFileSha256") });
    if (!parsed.success) return NextResponse.json({ error: "Preview the selected Payment Tracker file before staging it." }, { status: 422 });
    const importId = await finalizePaymentTrackerUpload(client, getSinglePaymentTrackerFile(formData), parsed.data.expectedFileSha256);
    return NextResponse.json({ importId }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Payment Tracker could not be staged." }, { status: 422 });
  }
}
