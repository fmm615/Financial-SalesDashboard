import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSinglePaymentTrackerFile } from "@/lib/validation/payment-tracker-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { previewPaymentTrackerUpload } from "@/server/services/payment-tracker-upload";

export const runtime = "nodejs";

/** Parses a selected Finance workbook in memory only; it never persists rows or source bytes. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const preview = await previewPaymentTrackerUpload(getSinglePaymentTrackerFile(await request.formData()));
    return NextResponse.json({ preview });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Payment Tracker preview could not be prepared." }, { status: 422 });
  }
}
