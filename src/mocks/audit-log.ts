import type { AuditEntry } from "@/types/dashboard";
export const auditEntries: AuditEntry[] = [
  { timestamp: "Aug 2, 2026 · 10:44", user: "A. Nasser", area: "Review Queue", record: "RV-1032", action: "Resolved flag", before: "Open", after: "Resolved", reason: "Refund linked and verified", source: "Manual review" },
  { timestamp: "Aug 1, 2026 · 16:10", user: "Layla Khan", area: "B2B", record: "Saha Holdings", action: "Updated stage", before: "Negotiation", after: "Closed won", reason: "Signed agreement received", source: "HubSpot sync" },
  { timestamp: "Aug 1, 2026 · 12:21", user: "Finance", area: "Finance", record: "Bank entry BE-019", action: "Created entry", before: "—", after: "$3,200", reason: "Approved IBAN transfer", source: "Manual entry" },
];
