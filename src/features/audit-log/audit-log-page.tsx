import { AppShell } from "@/components/app-shell";
import { DataTable, EmptyState, ErrorState, SectionCard, TableCell, TableHead, TableHeader } from "@/components/ui";
import type { AuditLogRecord } from "@/server/repositories/audit-log-repository";

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bahrain" }).format(new Date(value));
}

function snapshotSummary(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const summary = JSON.stringify(value);
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

/** The audit screen intentionally reads append-only source and correction history. */
export function AuditLogPage({ records = [], loadError }: { records?: AuditLogRecord[]; loadError?: string }) {
  return <AppShell title="Audit log" description="Append-only history of provider processing, local corrections, and Admin actions. Financial corrections include the saved reason and before/after values.">
    {loadError ? <ErrorState title="Audit history unavailable" description={loadError} /> : <SectionCard title="Audit activity" description="Newest first. Times are shown in Bahrain time. No row here can change Stripe, HubSpot, or a financial source record.">
      {records.length === 0 ? <EmptyState title="No audit history is available" description="Audit records appear here after the first provider or Admin action." /> : <DataTable caption="Audit activity"><TableHead><TableHeader>Date & time</TableHeader><TableHeader>User</TableHeader><TableHeader>Area</TableHeader><TableHeader>Record</TableHeader><TableHeader>Action</TableHeader><TableHeader>Before</TableHeader><TableHeader>After</TableHeader><TableHeader>Reason</TableHeader><TableHeader>Source</TableHeader></TableHead><tbody className="divide-y divide-line">{records.map((record) => <tr key={record.id}><TableCell>{formatTimestamp(record.occurredAt)}</TableCell><TableCell>{record.actor}</TableCell><TableCell>{record.area}</TableCell><TableCell className="font-mono text-xs">{record.recordId ?? "—"}</TableCell><TableCell className="font-medium">{record.action}</TableCell><TableCell className="max-w-44 break-words text-xs text-text-secondary"><span title={JSON.stringify(record.beforeValue)}>{snapshotSummary(record.beforeValue)}</span></TableCell><TableCell className="max-w-44 break-words text-xs text-text-secondary"><span title={JSON.stringify(record.afterValue)}>{snapshotSummary(record.afterValue)}</span></TableCell><TableCell className="max-w-52 break-words text-sm">{record.reason ?? "—"}</TableCell><TableCell>{record.source}</TableCell></tr>)}</tbody></DataTable>}
    </SectionCard>}
  </AppShell>;
}
