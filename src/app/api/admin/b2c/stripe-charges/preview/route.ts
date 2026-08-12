import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSingleStripeChargesFile } from "@/lib/validation/stripe-charges-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { previewStripeChargesUpload } from "@/server/services/stripe-charges-upload";

export const runtime = "nodejs";

/** Previews a Stripe Charges CSV in memory only; it creates no payment or evidence entry. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  try {
    return NextResponse.json({ preview: await previewStripeChargesUpload(getSingleStripeChargesFile(await request.formData())) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Stripe Charges preview could not be prepared." }, { status: 422 });
  }
}
