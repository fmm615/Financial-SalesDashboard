import type { Transaction } from "@/types/dashboard";
export const b2cTransactions: Transaction[] = [
  { customer: "Maya Al Khalifa", email: "maya@example.com", date: "Aug 2, 2026", amount: 399, category: "Membership", tier: "Premium", processor: "Stripe", status: "Completed", refund: "None" },
  { customer: "Omar Hassan", email: "omar@example.com", date: "Aug 2, 2026", amount: 149, category: "Workshop", tier: "Community", processor: "Tap", status: "Completed", refund: "None" },
  { customer: "Sara Patel", email: "sara@example.com", date: "Aug 1, 2026", amount: 399, category: "Membership", tier: "Premium", processor: "Stripe", status: "Failed", refund: "None", flag: "Failed" },
  { customer: "Daniel Reed", email: "daniel@example.com", date: "Aug 1, 2026", amount: 800, category: "Summit ticket", tier: "Member", processor: "IBAN", status: "Completed", refund: "Partial", flag: "Refunded" },
  { customer: "Lina Qureshi", email: "lina@example.com", date: "Jul 31, 2026", amount: 249, category: "Product review", tier: "Community", processor: "Tap", status: "Completed", refund: "None", flag: "Unmapped product" },
];
export const b2cKpis = [{ label: "Members today", value: "31", note: "+5 vs yesterday" }, { label: "Members MTD", value: "726", note: "+9.2% vs July" }, { label: "Daily revenue", value: "$4,820", note: "2 August" }, { label: "Monthly revenue", value: "$96,800", note: "Recognised sales" }];
export const processorSplit = [{ name: "Stripe", value: 64 }, { name: "Tap", value: 28 }, { name: "IBAN", value: 8 }];
export const acquisitionSources = [{ name: "Referral", value: 37 }, { name: "Organic", value: 28 }, { name: "Event", value: 21 }, { name: "Partner", value: 14 }];
