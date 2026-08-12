import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { getSingleTapStatementFile } from "@/lib/validation/tap-statement-upload-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { previewTapStatementUpload } from "@/server/services/tap-statement-upload";

export const runtime = "nodejs";

/** Previews a Tap CSV only in memory; it persists neither source bytes nor evidence rows. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  try {
    return NextResponse.json({ preview: await previewTapStatementUpload(getSingleTapStatementFile(await request.formData())) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Tap statement preview could not be prepared." }, { status: 422 });
  }
}
