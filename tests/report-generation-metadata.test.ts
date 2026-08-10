import { describe, expect, it } from "vitest";
import { createDraftReportJob, getDraftReportArchive, processDraftReportJob } from "@/server/services/process-draft-report";
import type { DatabaseClient } from "@/lib/supabase/server";

const reportJobId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

describe("report generation metadata", () => {
  it("marks queued report jobs as draft fixtures", async () => {
    let insertedJob: Record<string, unknown> | undefined;
    const client = {
      from(table: string) {
        if (table !== "report_jobs") throw new Error(`Unexpected table: ${table}`);
        return {
          insert(value: Record<string, unknown>) {
            insertedJob = value;
            return {
              select() {
                return { single: async () => ({ data: { id: reportJobId }, error: null }) };
              },
            };
          },
        };
      },
    } as unknown as DatabaseClient;

    await expect(createDraftReportJob(client, {
      reportType: "monthly", periodStart: "2026-08-01", periodEnd: "2026-08-31", deliveryRequested: false,
    }, userId)).resolves.toBe(reportJobId);

    expect(insertedJob).toMatchObject({
      report_type: "monthly",
      generation_mode: "draft_fixture",
      delivery_requested: false,
    });
  });

  it("refuses financial jobs before generation begins", async () => {
    const client = {
      from(table: string) {
        if (table !== "report_jobs") throw new Error(`Unexpected table: ${table}`);
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      id: reportJobId,
                      report_type: "monthly",
                      period_start: "2026-08-01",
                      period_end: "2026-08-31",
                      status: "pending",
                      retry_count: 0,
                      delivery_requested: false,
                      generation_mode: "financial",
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    } as unknown as DatabaseClient;

    await expect(processDraftReportJob(client, reportJobId)).rejects.toThrow("Financial report jobs are not enabled.");
  });

  it("stores snapshot readiness with a completed draft archive", async () => {
    const jobUpdates: Record<string, unknown>[] = [];
    let archivedReport: Record<string, unknown> | undefined;
    const client = {
      from(table: string) {
        if (table === "report_jobs") {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data: {
                        id: reportJobId,
                        report_type: "monthly",
                        period_start: "2026-08-01",
                        period_end: "2026-08-31",
                        status: "pending",
                        retry_count: 0,
                        delivery_requested: false,
                        generation_mode: "draft_fixture",
                      },
                      error: null,
                    }),
                  };
                },
              };
            },
            update(value: Record<string, unknown>) {
              jobUpdates.push(value);
              return { eq: async () => ({ error: null }) };
            },
          };
        }
        if (table === "reports") {
          return {
            upsert(value: Record<string, unknown>) {
              archivedReport = value;
              return {
                select() {
                  return { single: async () => ({ data: { id: "report-1" }, error: null }) };
                },
              };
            },
          };
        }
        if (table === "report_files") return { upsert: async () => ({ error: null }) };
        throw new Error(`Unexpected table: ${table}`);
      },
      storage: {
        from() {
          return { upload: async () => ({ error: null }) };
        },
      },
    } as unknown as DatabaseClient;

    await expect(processDraftReportJob(client, reportJobId)).resolves.toBeUndefined();

    expect(archivedReport).toMatchObject({
      job_id: reportJobId,
      snapshot_version: "1",
      readiness_status: "draft_fixture_only",
    });
    expect(jobUpdates).toContainEqual(expect.objectContaining({ status: "completed" }));
  });

  it("labels partial source coverage as incomplete instead of not loaded", async () => {
    const client = {
      from(table: string) {
        if (table === "report_jobs") {
          return {
            select() {
              return {
                order() {
                  return {
                    limit: async () => ({
                      data: [{
                        id: reportJobId,
                        report_type: "monthly",
                        period_start: "2026-08-01",
                        period_end: "2026-08-31",
                        status: "completed",
                        requested_at: "2026-08-31T09:00:00.000Z",
                        requested_by: userId,
                        safe_error_summary: null,
                      }],
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }
        if (table === "reports") {
          return {
            select() {
              return {
                in: async () => ({
                  data: [{
                    id: "report-1",
                    job_id: reportJobId,
                    snapshot_version: "1",
                    readiness_status: "draft_fixture_only",
                    summary_snapshot: { coverage: [{ area: "b2c", status: "partial" }] },
                  }],
                  error: null,
                }),
              };
            },
          };
        }
        if (table === "report_files") {
          return {
            select() {
              return { in: async () => ({ data: [], error: null }) };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    } as unknown as DatabaseClient;

    const [archiveItem] = await getDraftReportArchive(client);

    expect(archiveItem.coverageSummary).toBe("B2C is incomplete or unavailable.");
  });
});
