import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const decimalText = z.union([z.string(), z.number().finite()]).transform(String);
const nullableDecimalText = z.union([z.string(), z.number().finite()]).transform(String).nullable();
const stripeRefundEvidenceSchema = z.object({
  refundId: z.string().uuid(),
  originalAmount: decimalText,
  originalCurrency: z.string().length(3),
  settlementRefundAmount: nullableDecimalText,
  settlementCurrency: z.string().length(3).nullable(),
  settlementExchangeRate: nullableDecimalText,
}).strict();
const stripeEvidenceSchema = z.object({
  originalAmount: decimalText,
  originalCurrency: z.string().length(3),
  amountRefunded: nullableDecimalText,
  description: z.string().nullable(),
  sellerMessage: z.string().nullable(),
  cardholderName: z.string().nullable(),
  settlementGrossAmount: nullableDecimalText,
  settlementFeeAmount: nullableDecimalText,
  settlementFeeTaxAmount: nullableDecimalText,
  settlementNetAmount: nullableDecimalText,
  settlementCurrency: z.string().length(3).nullable(),
  settlementExchangeRate: nullableDecimalText,
  refunds: z.array(stripeRefundEvidenceSchema),
}).strict();
const evidenceSchema = z.object({
  payment_id: z.string().uuid(),
  source: z.string(),
  source_system: z.enum(["stripe", "tap", "manual_bank_transfer", "finance_tracker"]),
  provider_reference: z.string().nullable(),
  date_value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stripe_evidence: stripeEvidenceSchema.nullable(),
}).strict();

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
}

/**
 * Admin-only, single-payment provider evidence for the shared record drawer.
 * The database read is scoped by payment ID and never materializes history.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || requireMiddlewareRole(request) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }

  try {
    const { data, error } = await client.rpc("get_b2c_payment_evidence", { p_payment_id: paymentId });
    if (error) throw new Error("B2C evidence RPC failed.");
    if (data === null) return NextResponse.json({ error: "This B2C payment is unavailable." }, { status: 404 });
    const row = evidenceSchema.parse(data);
    return NextResponse.json({
      paymentId: row.payment_id,
      source: row.source,
      sourceSystem: row.source_system,
      providerReference: row.provider_reference,
      date: formatDate(row.date_value),
      stripeEvidence: row.stripe_evidence,
    });
  } catch {
    return NextResponse.json({ error: "Could not load B2C source evidence." }, { status: 500 });
  }
}
