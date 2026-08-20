import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cPostedFinanceAdjustmentSchema } from "@/lib/validation/b2c-posted-adjustment-contracts";
import { B2cPostedFinanceAdjustmentUnavailableError, SupabaseB2cFinancePaymentAdjustmentService } from "@/server/services/adjust-b2c-finance-payment";

/** Reads the current effective posted balance and audit history for one posted B2C Finance payment. Admin-only. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }

  try {
    const context = await new SupabaseB2cFinancePaymentAdjustmentService(client).loadContext(paymentId);
    return NextResponse.json({ context });
  } catch (caught) {
    const message = caught instanceof B2cPostedFinanceAdjustmentUnavailableError ? caught.message : "This B2C Finance payment is unavailable.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

/**
 * Applies a verified append-only correction to one posted B2C Finance
 * payment. The browser never constructs or signs an adjustment row -- it
 * sends only the values it believes are currently true plus the corrected
 * value(s); the server looks up the linked Finance row and calls the
 * existing expected-state RPC, which re-validates everything before writing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }
  const parsed = b2cPostedFinanceAdjustmentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance adjustment." }, { status: 422 });
  }

  try {
    const result = await new SupabaseB2cFinancePaymentAdjustmentService(client).apply(paymentId, parsed.data);
    return NextResponse.json(result);
  } catch (caught) {
    const message = caught instanceof B2cPostedFinanceAdjustmentUnavailableError
      ? caught.message
      : "This B2C Finance payment could not be adjusted. No source data was changed.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
