export type MetricTone = "positive" | "neutral" | "warning" | "danger";
export type RecordStatus = "Completed" | "Pending" | "Failed" | "Refunded" | "Open" | "Resolved" | "Processing" | "Not loaded";
export type ReviewFlag = "Refunded" | "Failed" | "Possible duplicate" | "Unmapped product" | "Needs follow-up";

export interface ExecutiveMetric { label: string; value: number | null; note: string; tone?: MetricTone; }
export interface TrendPoint { month: string; b2c: number; b2b: number; other: number; }
export interface Transaction { customer: string; email: string; date: string; amount: number; category: string; tier: string; processor: "Stripe" | "Tap" | "IBAN"; status: "Completed" | "Failed"; refund: "None" | "Full" | "Partial"; flag?: ReviewFlag; }
export interface Deal { company: string; name: string; owner: string; stage: string; category: string; amount: number; closeDate: string; bookingStatus: "Booked" | "Not booked" | "Pending"; recognisedStatus: "Recognised" | "Not recognised" | "Partial"; renewalDate: string; }
export interface Report { name: string; period: string; type: string; requestedBy: string; createdAt: string; status: "Pending" | "Processing" | "Completed" | "Failed"; }
export interface AuditEntry { timestamp: string; user: string; area: string; record: string; action: string; before: string; after: string; reason: string; source: string; }
