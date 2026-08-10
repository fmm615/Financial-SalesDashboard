import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const paramsSchema = z.object({ jobId: z.string().uuid(), fileKind: z.enum(["pdf", "csv_bundle"]) });

export async function GET(_: NextRequest, context: { params: Promise<{ jobId: string; fileKind: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !await getApprovedRole(client, user.id)) return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid report file." }, { status: 422 });
  const { data: report } = await client.from("reports").select("id").eq("job_id", parsed.data.jobId).maybeSingle();
  if (!report) return NextResponse.json({ error: "Report archive is unavailable." }, { status: 404 });
  const { data: file } = await client.from("report_files").select("storage_bucket,storage_path").eq("report_id", report.id).eq("file_kind", parsed.data.fileKind).maybeSingle();
  if (!file) return NextResponse.json({ error: "Report file is unavailable." }, { status: 404 });
  const { data, error } = await client.storage.from(file.storage_bucket).createSignedUrl(file.storage_path, 60);
  if (error || !data) return NextResponse.json({ error: "Report download could not be prepared." }, { status: 500 });
  return NextResponse.redirect(data.signedUrl);
}
