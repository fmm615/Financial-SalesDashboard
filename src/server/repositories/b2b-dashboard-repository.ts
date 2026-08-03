import type { DatabaseClient } from "@/lib/supabase/server";

export type B2bDashboardDeal = {
  id: string;
  company: string;
  name: string;
  owner: string | null;
  stage: string;
  amountUsd: string;
  closeDate: string | null;
  renewalDate: string | null;
  bookingStatus: "Booked" | "Not booked";
  recognisedStatus: "Recognised" | "Not recognised" | "Partial";
};

export type B2bDashboardSnapshot = {
  deals: B2bDashboardDeal[];
  openPipelineUsd: string;
  bookingsThisQuarterUsd: string;
  recognisedSalesThisMonthUsd: string;
};

const USD_SCALE = BigInt(1_000_000);

function requireKnownAmount(value: string | null): string {
  if (value === null) throw new Error("A reportable B2B deal is missing its USD amount.");
  return value;
}

function toScaledUsd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Stored B2B USD value is invalid.");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  return whole * USD_SCALE + fraction;
}

function formatUsd(value: bigint): string {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = absolute / USD_SCALE;
  const cents = (absolute % USD_SCALE) / BigInt(10_000);
  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

function quarterBounds(today: Date): { start: string; end: string } {
  const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
  const start = new Date(Date.UTC(today.getUTCFullYear(), quarterStartMonth, 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), quarterStartMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function monthBounds(today: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** Reads only the database view that excludes B2B deals awaiting Admin review. */
export async function getB2bDashboardSnapshot(client: DatabaseClient, today = new Date()): Promise<B2bDashboardSnapshot> {
  const { data: deals, error: dealsError } = await client
    .from("reportable_b2b_deals")
    .select("id,company_id,name,stage_code,pipeline_amount_usd,hubspot_close_date,renewal_date,owner_name")
    .order("updated_at", { ascending: false });
  if (dealsError) throw new Error(`Could not load reportable B2B deals: ${dealsError.message}`);

  const dealRows = deals ?? [];
  if (!dealRows.length) {
    return { deals: [], openPipelineUsd: "$0.00", bookingsThisQuarterUsd: "$0.00", recognisedSalesThisMonthUsd: "$0.00" };
  }

  const dealIds = dealRows.map((deal) => deal.id);
  const companyIds = [...new Set(dealRows.map((deal) => deal.company_id))];
  const [{ data: companies, error: companiesError }, { data: bookings, error: bookingsError }, { data: recognisedSales, error: recognisedSalesError }] = await Promise.all([
    client.from("b2b_companies").select("id,legal_name").in("id", companyIds),
    client.from("b2b_bookings").select("deal_id,booking_date,booking_amount_usd").in("deal_id", dealIds),
    client.from("b2b_recognised_sales").select("deal_id,recognition_date,recognised_amount_usd").in("deal_id", dealIds),
  ]);
  if (companiesError ?? bookingsError ?? recognisedSalesError) {
    throw new Error("Could not load the B2B financial records required for the dashboard.");
  }

  const companyNameById = new Map((companies ?? []).map((company) => [company.id, company.legal_name]));
  const bookingByDealId = new Map((bookings ?? []).map((booking) => [booking.deal_id, booking]));
  const recognisedByDealId = new Map<string, bigint>();
  for (const sale of recognisedSales ?? []) {
    recognisedByDealId.set(sale.deal_id, (recognisedByDealId.get(sale.deal_id) ?? BigInt(0)) + toScaledUsd(sale.recognised_amount_usd));
  }

  const quarter = quarterBounds(today);
  const month = monthBounds(today);
  let openPipeline = BigInt(0);
  let bookingsThisQuarter = BigInt(0);
  let recognisedSalesThisMonth = BigInt(0);

  for (const deal of dealRows) {
    if (deal.stage_code !== "closed_won" && deal.stage_code !== "closed_lost") openPipeline += toScaledUsd(requireKnownAmount(deal.pipeline_amount_usd));
  }
  for (const booking of bookings ?? []) {
    if (booking.booking_date >= quarter.start && booking.booking_date <= quarter.end) bookingsThisQuarter += toScaledUsd(booking.booking_amount_usd);
  }
  for (const sale of recognisedSales ?? []) {
    if (sale.recognition_date >= month.start && sale.recognition_date <= month.end) recognisedSalesThisMonth += toScaledUsd(sale.recognised_amount_usd);
  }

  return {
    deals: dealRows.map((deal) => {
      const booking = bookingByDealId.get(deal.id);
      const recognised = recognisedByDealId.get(deal.id) ?? BigInt(0);
      const amountUsd = requireKnownAmount(deal.pipeline_amount_usd);
      const amount = toScaledUsd(amountUsd);
      return {
        id: deal.id,
        company: companyNameById.get(deal.company_id) ?? "Unknown company",
        name: deal.name,
        owner: deal.owner_name,
        stage: deal.stage_code,
        amountUsd,
        closeDate: deal.hubspot_close_date,
        renewalDate: deal.renewal_date,
        bookingStatus: booking ? "Booked" : "Not booked",
        recognisedStatus: recognised === BigInt(0) ? "Not recognised" : recognised >= amount ? "Recognised" : "Partial",
      };
    }),
    openPipelineUsd: formatUsd(openPipeline),
    bookingsThisQuarterUsd: formatUsd(bookingsThisQuarter),
    recognisedSalesThisMonthUsd: formatUsd(recognisedSalesThisMonth),
  };
}
