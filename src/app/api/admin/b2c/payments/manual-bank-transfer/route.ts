import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manualBankTransferConfirmationSchema } from "@/lib/validation/financial-contracts";
import { SupabaseB2cPaymentsRepository } from "@/server/repositories/b2c-payments-repository";
import { recordManualBankTransfer } from "@/server/services/record-manual-bank-transfer";

export const runtime = "nodejs";

/**
 * Step 2's one final action: `Record bank transfer`. Re-hashes the reviewed
 * input against the preview's `inputSha256` and reruns every duplicate check
 * inside the protected database transaction -- the preview above is advisory
 * only. Records a genuinely new, USD-only, server-derived manual bank
 * transfer; an exact match is rejected, a possible match is retained with an
 * open review flag.
 */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = manualBankTransferConfirmationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Preview the bank transfer before recording it." }, { status: 422 });
  }

  try {
    const payment = await recordManualBankTransfer(parsed.data, new SupabaseB2cPaymentsRepository(client));
    return NextResponse.json({ payment }, { status: 201 });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "The manual bank transfer could not be recorded. No data was changed." }, { status: 422 });
  }
}
