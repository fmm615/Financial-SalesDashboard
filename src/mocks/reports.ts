import type { Report } from "@/types/dashboard";
export const reports: Report[] = [
  { name: "Monthly financial report", period: "July 2026", type: "Monthly", requestedBy: "M. Al Khalifa", createdAt: "Aug 1, 2026", status: "Completed" },
  { name: "Q2 management report", period: "Apr–Jun 2026", type: "Quarterly", requestedBy: "Finance", createdAt: "Jul 8, 2026", status: "Completed" },
  { name: "August operating snapshot", period: "Aug 1–2, 2026", type: "Ad-hoc", requestedBy: "T. Reed", createdAt: "Aug 2, 2026", status: "Processing" },
  { name: "Annual report", period: "2025", type: "Annual", requestedBy: "Finance", createdAt: "Jan 12, 2026", status: "Failed" },
];
