import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSingleStripeChargesFile, stripeChargesFinalizeSchema } from "@/lib/validation/stripe-charges-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizeStripeChargesUpload } from "@/server/services/stripe-charges-upload";

export const runtime = "nodejs";

/** Re-parses and hash-checks a Stripe Charges CSV before atomic evidence staging. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  try {
    const formData = await request.formData();
    const parsed = stripeChargesFinalizeSchema.safeParse({ expectedFileSha256: formData.get("expectedFileSha256") });
    if (!parsed.success) return NextResponse.json({ error: "Preview the selected Stripe Charges file before staging it." }, { status: 422 });
    return NextResponse.json({ importId: await finalizeStripeChargesUpload(client, getSingleStripeChargesFile(formData), parsed.data.expectedFileSha256) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Stripe Charges file could not be staged." }, { status: 422 });
  }
}
