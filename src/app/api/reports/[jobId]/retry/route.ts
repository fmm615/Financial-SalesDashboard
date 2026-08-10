import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const paramsSchema = z.object({ jobId: z.string().uuid() });

/** Requeues a failed draft job; the internal worker performs the actual generation. */
export async function POST(_: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid report job." }, { status: 422 });
  const { data: job, error: readError } = await client.from("report_jobs").select("status,retry_count,generation_mode").eq("id", parsed.data.jobId).maybeSingle();
  if (readError || !job || job.status !== "failed" || job.generation_mode !== "draft_fixture") return NextResponse.json({ error: "Only failed draft report jobs can be retried." }, { status: 422 });
  const { error } = await client.from("report_jobs").update({
    status: "pending", retry_count: job.retry_count + 1, failed_at: null, safe_error_summary: null, generation_mode: "draft_fixture",
  }).eq("id", parsed.data.jobId);
  if (error) return NextResponse.json({ error: "The report job could not be requeued." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
