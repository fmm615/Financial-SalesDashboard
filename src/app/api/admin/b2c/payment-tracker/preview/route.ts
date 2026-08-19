import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSinglePaymentTrackerFile, paymentTrackerPreviewSchema } from "@/lib/validation/payment-tracker-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { previewPaymentTrackerUpload } from "@/server/services/payment-tracker-upload";

export const runtime = "nodejs";

/** Parses a selected Finance workbook and safely counts it against the declared prior import; it never persists rows or source bytes. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  try {
    const formData = await request.formData();
    const parsed = paymentTrackerPreviewSchema.safeParse({ supersedesImportId: formData.get("supersedesImportId") || undefined });
    if (!parsed.success) return NextResponse.json({ error: "Invalid B2C Finance import replacement reference." }, { status: 422 });
    const preview = await previewPaymentTrackerUpload(client, getSinglePaymentTrackerFile(formData), parsed.data.supersedesImportId ?? null);
    return NextResponse.json({ preview });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Payment Tracker preview could not be prepared." }, { status: 422 });
  }
}
