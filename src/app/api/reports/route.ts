import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { firstValidationMessage, reportRequestSchema } from "@/lib/validation/financial-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createDraftReportJob, getDraftReportArchive } from "@/server/services/process-draft-report";

export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !await getApprovedRole(client, user.id)) return NextResponse.json({ error: "Approved access is required." }, { status: 403 });
  try {
    return NextResponse.json({ reports: await getDraftReportArchive(client) });
  } catch {
    return NextResponse.json({ error: "The report archive could not be loaded." }, { status: 500 });
  }
}

/** Queues an isolated draft report. It intentionally has no provider financial data. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const parsed = reportRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: firstValidationMessage(parsed.error) }, { status: 422 });
  if (parsed.data.deliveryRequested) return NextResponse.json({ error: "Email delivery remains disabled until financial report accuracy is verified." }, { status: 422 });
  try {
    const jobId = await createDraftReportJob(client, parsed.data, user.id);
    return NextResponse.json({ jobId }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "The draft report could not be queued." }, { status: 500 });
  }
}
