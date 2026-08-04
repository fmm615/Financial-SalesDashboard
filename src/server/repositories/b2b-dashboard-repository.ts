import type { DatabaseClient } from "@/lib/supabase/server";

export type B2bDashboardDeal = {
  id: string;
  bookingId: string | null;
  name: string;
  owner: string | null;
  stage: string;
  amountUsd: string | null;
  originalAmount: string | null;
  originalCurrency: string | null;
  exchangeRateToUsd: string | null;
  closeDate: string | null;
  renewalDate: string | null;
  bookingStatus: "Booked" | "Not booked";
  recognisedStatus: "Recognised" | "Not recognised" | "Partial" | "Unavailable";
  recognisedTotalUsd: string | null;
  issue: string | null;
};

export type B2bReportingPeriod = {
  month: string;
  monthLabel: string;
  quarterLabel: string;
  monthStart: string;
  monthEnd: string;
  quarterStart: string;
  quarterEnd: string;
};

export type B2bDashboardSnapshot = { deals: B2bDashboardDeal[]; openPipelineUsd: string; bookingsThisQuarterUsd: string; recognisedSalesThisMonthUsd: string | null; period: B2bReportingPeriod };

const USD_SCALE = BigInt(1_000_000);

function toScaledUsd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Stored B2B USD value is invalid.");
  return BigInt(match[1]) * USD_SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function formatUsd(value: bigint): string {
  const whole = value / USD_SCALE;
  const cents = (value % USD_SCALE) / BigInt(10_000);
  return `$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function resolveB2bReportingPeriod(selectedMonth: string | undefined, today = new Date()): B2bReportingPeriod {
  const fallback = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth ?? "") ? selectedMonth! : fallback;
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex, 0));
  const quarterStartMonth = Math.floor((monthIndex - 1) / 3) * 3;
  const quarterStart = new Date(Date.UTC(year, quarterStartMonth, 1));
  const quarterEnd = new Date(Date.UTC(year, quarterStartMonth + 3, 0));
  return {
    month,
    monthLabel: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date),
    quarterLabel: `Q${Math.floor((monthIndex - 1) / 3) + 1} ${year}`,
    monthStart: date.toISOString().slice(0, 10),
    monthEnd: monthEnd.toISOString().slice(0, 10),
    quarterStart: quarterStart.toISOString().slice(0, 10),
    quarterEnd: quarterEnd.toISOString().slice(0, 10),
  };
}

function issueForDeal(deal: { financial_status: string; duplicate_review_status: string; stage_code: string; hubspot_close_date: string | null }, reviewReason: string | undefined): string | null {
  if (deal.duplicate_review_status === "needs_review") return "Possible duplicate";
  if (deal.financial_status === "needs_review") return reviewReason ?? "Needs financial details";
  if (deal.stage_code === "closed_won" && !deal.hubspot_close_date) return "Needs close date";
  return reviewReason ?? null;
}

/** Returns all active HubSpot and Finance-entered B2B deals, while KPI totals use only reportable rows. */
export async function getB2bDashboardSnapshot(client: DatabaseClient, today = new Date(), selectedMonth?: string): Promise<B2bDashboardSnapshot> {
  const period = resolveB2bReportingPeriod(selectedMonth, today);
  const [allDealsResult, reportableDealsResult] = await Promise.all([
    client.from("b2b_deals").select("id,name,owner_name,stage_code,financial_status,duplicate_review_status,pipeline_original_amount,original_currency,exchange_rate_to_usd,pipeline_amount_usd,hubspot_close_date,renewal_date").in("source_system", ["hubspot", "manual_finance"]).eq("local_record_status", "active").order("updated_at", { ascending: false }),
    client.from("reportable_b2b_deals").select("id,stage_code,pipeline_amount_usd"),
  ]);
  if (allDealsResult.error ?? reportableDealsResult.error) throw new Error("Could not load B2B source deals.");
  const allDeals = allDealsResult.data ?? [];
  const reportableDeals = reportableDealsResult.data ?? [];
  if (!allDeals.length) return { deals: [], openPipelineUsd: "$0.00", bookingsThisQuarterUsd: "$0.00", recognisedSalesThisMonthUsd: null, period };

  const ids = allDeals.map((deal) => deal.id);
  const reportableDealIds = new Set(reportableDeals.map((deal) => deal.id));
  const [{ data: bookings, error: bookingsError }, { data: sales, error: salesError }, { data: flags, error: flagsError }] = await Promise.all([
    client.from("b2b_bookings").select("id,deal_id,booking_date,booking_amount_usd").in("deal_id", ids),
    client.from("b2b_recognised_sales").select("deal_id,recognition_date,recognised_amount_usd").in("deal_id", ids),
    client.from("review_flags").select("source_record_id,reason").eq("source_area", "b2b_deal").eq("status", "open").in("source_record_id", ids),
  ]);
  if (bookingsError ?? salesError ?? flagsError) throw new Error("Could not load B2B deal status details.");

  const bookingByDeal = new Map((bookings ?? []).map((booking) => [booking.deal_id, booking]));
  const reviewReasonByDeal = new Map((flags ?? []).map((flag) => [flag.source_record_id, flag.reason]));
  const recognisedByDeal = new Map<string, bigint>();
  for (const sale of sales ?? []) recognisedByDeal.set(sale.deal_id, (recognisedByDeal.get(sale.deal_id) ?? BigInt(0)) + toScaledUsd(sale.recognised_amount_usd));

  let openPipeline = BigInt(0);
  for (const deal of reportableDeals) if (deal.stage_code !== "closed_won" && deal.stage_code !== "closed_lost" && deal.pipeline_amount_usd) openPipeline += toScaledUsd(deal.pipeline_amount_usd);
  let bookingsThisQuarter = BigInt(0);
  // A booking belonging to a locally excluded or unresolved deal is retained for
  // traceability but must never make its way into an operational financial total.
  for (const booking of bookings ?? []) {
    if (reportableDealIds.has(booking.deal_id) && booking.booking_date >= period.quarterStart && booking.booking_date <= period.quarterEnd) {
      bookingsThisQuarter += toScaledUsd(booking.booking_amount_usd);
    }
  }
  let recognisedSalesThisMonth = BigInt(0);
  let hasRecognisedSalesThisMonth = false;
  for (const sale of sales ?? []) {
    if (reportableDealIds.has(sale.deal_id) && sale.recognition_date >= period.monthStart && sale.recognition_date <= period.monthEnd) {
      recognisedSalesThisMonth += toScaledUsd(sale.recognised_amount_usd);
      hasRecognisedSalesThisMonth = true;
    }
  }

  return {
    deals: allDeals.map((deal) => {
      const recognised = recognisedByDeal.get(deal.id) ?? BigInt(0);
      const amount = deal.pipeline_amount_usd ? toScaledUsd(deal.pipeline_amount_usd) : null;
      return {
        id: deal.id, bookingId: bookingByDeal.get(deal.id)?.id ?? null, name: deal.name, owner: deal.owner_name, stage: deal.stage_code,
        amountUsd: deal.pipeline_amount_usd, originalAmount: deal.pipeline_original_amount, originalCurrency: deal.original_currency, exchangeRateToUsd: deal.exchange_rate_to_usd,
        closeDate: deal.hubspot_close_date, renewalDate: deal.renewal_date,
        bookingStatus: bookingByDeal.has(deal.id) ? "Booked" : "Not booked",
        recognisedStatus: amount === null ? "Unavailable" : recognised === BigInt(0) ? "Not recognised" : recognised >= amount ? "Recognised" : "Partial",
        recognisedTotalUsd: recognised === BigInt(0) ? null : formatUsd(recognised),
        issue: issueForDeal(deal, reviewReasonByDeal.get(deal.id)),
      };
    }),
    openPipelineUsd: formatUsd(openPipeline), bookingsThisQuarterUsd: formatUsd(bookingsThisQuarter), recognisedSalesThisMonthUsd: hasRecognisedSalesThisMonth ? formatUsd(recognisedSalesThisMonth) : null, period,
  };
}
