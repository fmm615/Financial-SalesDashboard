import { AuditLogPage } from "@/features/audit-log/audit-log-page";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuditLogRecords } from "@/server/repositories/audit-log-repository";

export default async function AuditLogRoute() {
  try {
    return <AuditLogPage records={await getAuditLogRecords(await createServerSupabaseClient())} />;
  } catch {
    return <AuditLogPage loadError="Audit history could not be loaded. Admin access is required." />;
  }
}
