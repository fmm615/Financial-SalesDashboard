import type { Deal } from "@/types/dashboard";
export const b2bDeals: Deal[] = [
  { company: "Al Noor Group", name: "Leadership partnership renewal", owner: "Layla Khan", stage: "Proposal", category: "Partnership", amount: 95000, closeDate: "Aug 18, 2026", bookingStatus: "Pending", recognisedStatus: "Not recognised", renewalDate: "Sep 1, 2026" },
  { company: "Gulf Ventures", name: "Executive learning programme", owner: "Tom Reed", stage: "Negotiation", category: "Programme", amount: 78000, closeDate: "Aug 26, 2026", bookingStatus: "Pending", recognisedStatus: "Not recognised", renewalDate: "—" },
  { company: "Saha Holdings", name: "Summit sponsorship", owner: "Layla Khan", stage: "Closed won", category: "Sponsorship", amount: 126000, closeDate: "Aug 1, 2026", bookingStatus: "Booked", recognisedStatus: "Partial", renewalDate: "Aug 2027" },
  { company: "North Star", name: "Team membership", owner: "Tom Reed", stage: "Discovery", category: "Membership", amount: 36000, closeDate: "Sep 12, 2026", bookingStatus: "Not booked", recognisedStatus: "Not recognised", renewalDate: "—" },
];
export const pipelineStages = [{ name: "Discovery", value: 142000 }, { name: "Qualified", value: 184000 }, { name: "Proposal", value: 190000 }, { name: "Negotiation", value: 126000 }];
export const b2bKpis = [{ label: "Open pipeline", value: "$642,000", note: "Weighted pipeline" }, { label: "Bookings this quarter", value: "$302,000", note: "Closed-won only" }, { label: "Recognised sales", value: "$87,400", note: "This month; separate from bookings" }, { label: "Win rate", value: "42%", note: "+4.1 pts vs Q2" }, { label: "Deal velocity", value: "38 days", note: "Median close time" }, { label: "Stuck deals", value: "4", note: "No movement in 21 days" }];
