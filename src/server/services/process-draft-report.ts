import { createDraftReportContent } from "@/lib/reports/draft-report-content";
import { createDraftReportSnapshot } from "@/lib/reports/report-data";
import { createSimplePdf } from "@/lib/reports/simple-pdf";
import type { ReportRequestInput } from "@/lib/validation/financial-contracts";
import type { DatabaseClient } from "@/lib/supabase/server";

const reportBucket = "report-archives";

function safeErrorSummary(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "Draft report processing failed.";
}

export async function createDraftReportJob(client: DatabaseClient, request: ReportRequestInput, userId: string): Promise<string> {
  if (request.deliveryRequested) throw new Error("Email delivery is not enabled for draft reports.");
  const { data, error } = await client.from("report_jobs").insert({
    report_type: request.reportType,
    period_start: request.periodStart,
    period_end: request.periodEnd,
    requested_by: userId,
    delivery_requested: false,
  }).select("id").single();
  if (error || !data) throw new Error("Could not queue the draft report.");
  return data.id;
}

export async function processDraftReportJob(client: DatabaseClient, jobId: string): Promise<void> {
  const { data: job, error: jobError } = await client.from("report_jobs")
    .select("id,report_type,period_start,period_end,status,retry_count,delivery_requested")
    .eq("id", jobId).maybeSingle();
  if (jobError || !job) throw new Error("Report job was not found.");
  if (job.status === "completed") return;
  if (job.status === "processing") throw new Error("Report job is already processing.");

  const retryCount = job.status === "failed" ? job.retry_count + 1 : job.retry_count;
  const started = await client.from("report_jobs").update({
    status: "processing", started_at: new Date().toISOString(), failed_at: null, safe_error_summary: null, retry_count: retryCount,
  }).eq("id", job.id);
  if (started.error) throw new Error("Could not start the draft report job.");

  try {
    const request: ReportRequestInput = {
      reportType: job.report_type,
      periodStart: job.period_start,
      periodEnd: job.period_end,
      deliveryRequested: job.delivery_requested,
    };
    const content = createDraftReportContent(createDraftReportSnapshot(request));
    const basePath = `draft/${job.id}/${job.report_type}-${job.period_start}-${job.period_end}`;
    const uploads = await Promise.all([
      client.storage.from(reportBucket).upload(`${basePath}.pdf`, createSimplePdf(content.pdfLines), { contentType: "application/pdf", upsert: true }),
      client.storage.from(reportBucket).upload(`${basePath}.csv`, new TextEncoder().encode(content.csv), { contentType: "text/csv; charset=utf-8", upsert: true }),
    ]);
    if (uploads.some(({ error }) => error)) throw new Error("Could not archive draft report files.");

    const { data: report, error: reportError } = await client.from("reports")
      .upsert({ job_id: job.id, summary_snapshot: content.summarySnapshot }, { onConflict: "job_id" })
      .select("id").single();
    if (reportError || !report) throw new Error("Could not save the draft report archive.");
    const fileResult = await client.from("report_files").upsert([
      { report_id: report.id, file_kind: "pdf", storage_bucket: reportBucket, storage_path: `${basePath}.pdf` },
      { report_id: report.id, file_kind: "csv_bundle", storage_bucket: reportBucket, storage_path: `${basePath}.csv` },
    ], { onConflict: "report_id,file_kind" });
    if (fileResult.error) throw new Error("Could not save draft report file references.");
    const completed = await client.from("report_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", job.id);
    if (completed.error) throw new Error("Could not complete the draft report job.");
  } catch (error) {
    await client.from("report_jobs").update({
      status: "failed", failed_at: new Date().toISOString(), safe_error_summary: safeErrorSummary(error),
    }).eq("id", job.id);
    throw error;
  }
}

/** Selects one durable pending job for a trusted scheduled worker. */
export async function processNextDraftReportJob(client: DatabaseClient): Promise<string | null> {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { error: staleError } = await client.from("report_jobs").update({
    status: "failed",
    failed_at: new Date().toISOString(),
    safe_error_summary: "Draft report processing exceeded the 15-minute worker limit. Requeue it after review.",
  }).eq("status", "processing").lt("started_at", staleBefore);
  if (staleError) throw new Error("Could not recover stale draft report jobs.");
  const { data: job, error } = await client.from("report_jobs")
    .select("id").eq("status", "pending").order("requested_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error("Could not find a pending draft report.");
  if (!job) return null;
  await processDraftReportJob(client, job.id);
  return job.id;
}

export type DraftReportArchiveItem = {
  id: string;
  reportType: "monthly" | "quarterly" | "annual" | "ad_hoc";
  periodStart: string;
  periodEnd: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  requestedAt: string;
  requestedBy: string | null;
  safeErrorSummary: string | null;
  hasPdf: boolean;
  hasCsv: boolean;
};

export async function getDraftReportArchive(client: DatabaseClient): Promise<DraftReportArchiveItem[]> {
  const { data: jobs, error: jobsError } = await client.from("report_jobs")
    .select("id,report_type,period_start,period_end,status,requested_at,requested_by,safe_error_summary")
    .order("requested_at", { ascending: false }).limit(100);
  if (jobsError) throw new Error("Could not load the report archive.");
  const jobIds = (jobs ?? []).map((job) => job.id);
  const { data: reports, error: reportsError } = jobIds.length
    ? await client.from("reports").select("id,job_id").in("job_id", jobIds)
    : { data: [], error: null };
  if (reportsError) throw new Error("Could not load the report archive.");
  const reportIds = (reports ?? []).map((report) => report.id);
  const { data: files, error: filesError } = reportIds.length
    ? await client.from("report_files").select("report_id,file_kind").in("report_id", reportIds)
    : { data: [], error: null };
  if (filesError) throw new Error("Could not load the report archive.");
  const reportByJobId = new Map((reports ?? []).map((report) => [report.job_id, report.id]));
  const fileKindsByReportId = new Map<string, Set<string>>();
  for (const file of files ?? []) {
    const kinds = fileKindsByReportId.get(file.report_id) ?? new Set<string>();
    kinds.add(file.file_kind);
    fileKindsByReportId.set(file.report_id, kinds);
  }
  return (jobs ?? []).map((job) => {
    const reportId = reportByJobId.get(job.id);
    const fileKinds = reportId ? fileKindsByReportId.get(reportId) : undefined;
    return {
      id: job.id,
      reportType: job.report_type,
      periodStart: job.period_start,
      periodEnd: job.period_end,
      status: job.status,
      requestedAt: job.requested_at,
      requestedBy: job.requested_by,
      safeErrorSummary: job.safe_error_summary,
      hasPdf: fileKinds?.has("pdf") ?? false,
      hasCsv: fileKinds?.has("csv_bundle") ?? false,
    };
  });
}
