import type { DatabaseClient } from "@/lib/supabase/server";

const USD_SCALE = BigInt(1_000_000);

export type B2cReportingPeriod = { month: string; monthLabel: string; monthStart: string; monthEnd: string };
export type B2cLedgerRow = {
  id: string;
  recordType: "Payment" | "Refund";
  customerEmail: string;
  customerPhone: string | null;
  date: string;
  amountUsd: string;
  category: string;
  membershipTier: string | null;
  source: string;
  paymentStatus: "Completed" | "Failed" | "Pending" | "Refunded";
  providerReference: string | null;
  issue: "Possible duplicate" | "Unmapped product" | "Failed" | "Needs follow-up" | "Refunded" | null;
};
export type B2cDashboardSnapshot = {
  period: B2cReportingPeriod;
  hasSourceRecords: boolean;
  eligiblePaymentsUsd: string;
  refundsUsd: string;
  netPaymentsUsd: string;
  reviewItems: number;
  rows: B2cLedgerRow[];
};

type Flag = { source_area: string; source_record_id: string; flag_type: string; reason: string };

function toScaledUsd(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Stored B2C USD value is invalid.");
  return BigInt(match[1]) * USD_SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function formatUsd(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  const whole = absolute / USD_SCALE;
  const cents = (absolute % USD_SCALE) / BigInt(10_000);
  return `${value < BigInt(0) ? "−" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
}

function flagLabel(flags: Flag[]): B2cLedgerRow["issue"] {
  const types = new Set(flags.map((flag) => flag.flag_type));
  if (types.has("possible_duplicate")) return "Possible duplicate";
  if (types.has("unmapped_product")) return "Unmapped product";
  if (types.has("failed")) return "Failed";
  if (types.has("needs_follow_up")) return "Needs follow-up";
  if (types.has("refunded")) return "Refunded";
  return null;
}

function displayPaymentStatus(status: "succeeded" | "failed" | "pending"): B2cLedgerRow["paymentStatus"] {
  if (status === "succeeded") return "Completed";
  if (status === "failed") return "Failed";
  return "Pending";
}

export function resolveB2cReportingPeriod(selectedMonth: string | undefined, today = new Date()): B2cReportingPeriod {
  const fallback = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth ?? "") ? selectedMonth! : fallback;
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex, 0));
  return {
    month,
    monthLabel: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date),
    monthStart: date.toISOString().slice(0, 10),
    monthEnd: monthEnd.toISOString().slice(0, 10),
  };
}

/**
 * Produces a ledger-oriented B2C snapshot. A payment is reportable only when it
 * succeeded and has neither an open duplicate nor an unmapped-product flag.
 * Refunds remain separate source records and reduce only the net-payment metric.
 */
export async function getB2cDashboardSnapshot(client: DatabaseClient, today = new Date(), selectedMonth?: string): Promise<B2cDashboardSnapshot> {
  const period = resolveB2cReportingPeriod(selectedMonth, today);
  const [paymentsResult, refundsResult, paymentFlagsResult, refundFlagsResult] = await Promise.all([
    client.from("b2c_payments").select("id,source_system,provider_transaction_id,customer_email,customer_phone,category_code,membership_tier,payment_status,amount_usd,occurred_on").order("occurred_at", { ascending: false }),
    client.from("b2c_refunds").select("id,payment_id,source_system,provider_refund_id,amount_usd,occurred_at").order("occurred_at", { ascending: false }),
    client.from("review_flags").select("source_area,source_record_id,flag_type,reason").eq("source_area", "b2c_payment").eq("status", "open"),
    client.from("review_flags").select("source_area,source_record_id,flag_type,reason").eq("source_area", "b2c_refund").eq("status", "open"),
  ]);
  if (paymentsResult.error ?? refundsResult.error ?? paymentFlagsResult.error ?? refundFlagsResult.error) {
    throw new Error("Could not load B2C source records.");
  }

  const payments = paymentsResult.data ?? [];
  const refunds = refundsResult.data ?? [];
  const flagsByRecord = new Map<string, Flag[]>();
  for (const flag of [...(paymentFlagsResult.data ?? []), ...(refundFlagsResult.data ?? [])]) {
    flagsByRecord.set(flag.source_record_id, [...(flagsByRecord.get(flag.source_record_id) ?? []), flag]);
  }
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  const isReportablePayment = (payment: typeof payments[number]) => {
    const flagTypes = new Set((flagsByRecord.get(payment.id) ?? []).map((flag) => flag.flag_type));
    return payment.payment_status === "succeeded" && !flagTypes.has("possible_duplicate") && !flagTypes.has("unmapped_product");
  };

  let eligiblePayments = BigInt(0);
  let refundsTotal = BigInt(0);
  for (const payment of payments) {
    if (payment.occurred_on >= period.monthStart && payment.occurred_on <= period.monthEnd && isReportablePayment(payment)) {
      eligiblePayments += toScaledUsd(payment.amount_usd);
    }
  }
  for (const refund of refunds) {
    const occurredOn = refund.occurred_at.slice(0, 10);
    const payment = paymentById.get(refund.payment_id);
    if (occurredOn >= period.monthStart && occurredOn <= period.monthEnd && payment && isReportablePayment(payment)) {
      refundsTotal += toScaledUsd(refund.amount_usd);
    }
  }

  const rows: B2cLedgerRow[] = [
    ...payments.filter((payment) => payment.occurred_on >= period.monthStart && payment.occurred_on <= period.monthEnd).map((payment) => ({
      id: payment.id,
      recordType: "Payment" as const,
      customerEmail: payment.customer_email,
      customerPhone: payment.customer_phone,
      date: formatDate(payment.occurred_on),
      amountUsd: formatUsd(toScaledUsd(payment.amount_usd)),
      category: payment.category_code === "unmapped" ? "Unmapped" : payment.category_code,
      membershipTier: payment.membership_tier,
      source: payment.source_system === "manual_bank_transfer" ? "Manual bank transfer" : payment.source_system === "stripe" ? "Stripe" : "Tap",
      paymentStatus: displayPaymentStatus(payment.payment_status),
      providerReference: payment.provider_transaction_id,
      issue: flagLabel(flagsByRecord.get(payment.id) ?? []),
    })),
    ...refunds.filter((refund) => {
      const occurredOn = refund.occurred_at.slice(0, 10);
      return occurredOn >= period.monthStart && occurredOn <= period.monthEnd;
    }).map((refund) => {
      const payment = paymentById.get(refund.payment_id);
      return {
        id: refund.id,
        recordType: "Refund" as const,
        customerEmail: payment?.customer_email ?? "Unknown source payment",
        customerPhone: payment?.customer_phone ?? null,
        date: formatDate(refund.occurred_at.slice(0, 10)),
        amountUsd: formatUsd(-toScaledUsd(refund.amount_usd)),
        category: payment?.category_code === "unmapped" ? "Unmapped" : payment?.category_code ?? "Unavailable",
        membershipTier: payment?.membership_tier ?? null,
        source: refund.source_system === "stripe" ? "Stripe" : refund.source_system === "tap" ? "Tap" : "Manual bank transfer",
        paymentStatus: "Refunded" as const,
        providerReference: refund.provider_refund_id,
        issue: flagLabel(flagsByRecord.get(refund.id) ?? []),
      };
    }),
  ].sort((first, second) => second.date.localeCompare(first.date));

  return {
    period,
    hasSourceRecords: payments.length > 0 || refunds.length > 0,
    eligiblePaymentsUsd: formatUsd(eligiblePayments),
    refundsUsd: formatUsd(refundsTotal),
    netPaymentsUsd: formatUsd(eligiblePayments - refundsTotal),
    reviewItems: [...flagsByRecord.values()].reduce((sum, flags) => sum + flags.length, 0),
    rows,
  };
}
