import { NextRequest, NextResponse } from "next/server";
import { createServiceDatabaseClient } from "@/lib/supabase/server";
import { processNextDraftReportJob } from "@/server/services/process-draft-report";

export const runtime = "nodejs";

/** Protected worker entry point. Configure a scheduler after the draft workflow is verified. */
export async function POST(request: NextRequest) {
  const expectedSecret = process.env.REPORT_JOB_CRON_SECRET;
  const suppliedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expectedSecret || suppliedSecret !== expectedSecret) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const jobId = await processNextDraftReportJob(createServiceDatabaseClient());
    return NextResponse.json({ jobId, processed: Boolean(jobId) });
  } catch {
    return NextResponse.json({ error: "The draft report worker failed." }, { status: 500 });
  }
}
