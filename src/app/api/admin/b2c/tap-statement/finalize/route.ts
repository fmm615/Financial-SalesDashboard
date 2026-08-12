import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSingleTapStatementFile, tapStatementFinalizeSchema } from "@/lib/validation/tap-statement-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizeTapStatementUpload } from "@/server/services/tap-statement-upload";

export const runtime = "nodejs";

/** Re-parses and hash-checks a Tap statement before staging all evidence lines atomically. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  try {
    const formData = await request.formData();
    const parsed = tapStatementFinalizeSchema.safeParse({ expectedFileSha256: formData.get("expectedFileSha256") });
    if (!parsed.success) return NextResponse.json({ error: "Preview the selected Tap statement file before staging it." }, { status: 422 });
    return NextResponse.json({ importId: await finalizeTapStatementUpload(client, getSingleTapStatementFile(formData), parsed.data.expectedFileSha256) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Tap statement could not be staged." }, { status: 422 });
  }
}
