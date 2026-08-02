import type { ExecutiveMetric, TrendPoint } from "@/types/dashboard";

export const executiveMetrics: ExecutiveMetric[] = [
  { label: "Sales this month", value: 184200, note: "Recognised sales only", tone: "positive" },
  { label: "Monthly target", value: 170000, note: "108.4% of target", tone: "positive" },
  { label: "B2C sales", value: 96800, note: "Recognised this month" },
  { label: "B2B recognised sales", value: 87400, note: "Excludes bookings" },
  { label: "B2B bookings", value: 126000, note: "Closed-won this month", tone: "neutral" },
  { label: "Open B2B pipeline", value: 642000, note: "Weighted by stage" },
];
export const salesTrend: TrendPoint[] = [
  { month: "Mar", b2c: 78000, b2b: 60000, other: 4000 }, { month: "Apr", b2c: 82400, b2b: 68400, other: 3800 }, { month: "May", b2c: 89100, b2b: 71100, other: 4200 },
  { month: "Jun", b2c: 91300, b2b: 76500, other: 3500 }, { month: "Jul", b2c: 94000, b2b: 82300, other: 4000 }, { month: "Aug", b2c: 96800, b2b: 87400, other: 4300 },
];
export const risksAndOpportunities = [
  { type: "Opportunity", title: "Al Noor Group renewal", detail: "$95k renewal decision expected this month", tone: "positive" as const },
  { type: "Risk", title: "B2C payment retries", detail: "12 failed payments require recovery follow-up", tone: "warning" as const },
  { type: "Opportunity", title: "Corporate pipeline", detail: "Three late-stage deals total $210k", tone: "positive" as const },
  { type: "Risk", title: "Historical expense detail", detail: "Expense data prior to January is not yet backfilled", tone: "neutral" as const },
];
