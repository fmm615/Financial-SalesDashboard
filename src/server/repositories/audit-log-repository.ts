import type { DatabaseClient } from "@/lib/supabase/server";

export type AuditLogRecord = {
  id: string;
  occurredAt: string;
  actor: string;
  area: string;
  recordId: string | null;
  action: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  source: "Database audit" | "Financial correction";
};

/** Reads append-only audit history through the authenticated Admin RLS policy. */
export async function getAuditLogRecords(client: DatabaseClient): Promise<AuditLogRecord[]> {
  const [eventsResult, correctionsResult] = await Promise.all([
    client.from("audit_events").select("id,actor_email,area,record_id,action,before_value,after_value,reason,occurred_at").order("occurred_at", { ascending: false }).limit(200),
    client.from("financial_corrections").select("id,target_area,target_record_id,correction_type,before_value,after_value,reason,created_by,created_at").order("created_at", { ascending: false }).limit(200),
  ]);
  if (eventsResult.error ?? correctionsResult.error) throw new Error("Could not load audit history.");

  const profileIds = [...new Set((correctionsResult.data ?? []).map((correction) => correction.created_by))];
  const profilesResult = profileIds.length
    ? await client.from("profiles").select("id,email").in("id", profileIds)
    : { data: [], error: null };
  if (profilesResult.error) throw new Error("Could not load audit history.");
  const emailByProfileId = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.email]));

  return [
    ...(eventsResult.data ?? []).map((event): AuditLogRecord => ({
      id: `event-${event.id}`,
      occurredAt: event.occurred_at,
      actor: event.actor_email ?? "System",
      area: event.area,
      recordId: event.record_id,
      action: event.action,
      beforeValue: event.before_value,
      afterValue: event.after_value,
      reason: event.reason,
      source: "Database audit",
    })),
    ...(correctionsResult.data ?? []).map((correction): AuditLogRecord => ({
      id: `correction-${correction.id}`,
      occurredAt: correction.created_at,
      actor: emailByProfileId.get(correction.created_by) ?? "Admin",
      area: correction.target_area,
      recordId: correction.target_record_id,
      action: correction.correction_type,
      beforeValue: correction.before_value,
      afterValue: correction.after_value,
      reason: correction.reason,
      source: "Financial correction",
    })),
  ].sort((first, second) => second.occurredAt.localeCompare(first.occurredAt));
}
