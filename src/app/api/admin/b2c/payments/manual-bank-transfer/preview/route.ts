import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manualBankTransferSchema } from "@/lib/validation/financial-contracts";
import { SupabaseB2cPaymentsRepository } from "@/server/repositories/b2c-payments-repository";
import { previewManualBankTransfer } from "@/server/services/record-manual-bank-transfer";

export const runtime = "nodejs";

/**
 * Read-only, advisory duplicate assessment for Step 1 of the `Add bank
 * transfer` flow. Never writes and never discloses a private source row --
 * only the safe match summary the Admin needs to decide whether to proceed.
 */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = manualBankTransferSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Enter every required bank transfer detail." }, { status: 422 });
  }

  try {
    const assessment = await previewManualBankTransfer(parsed.data, new SupabaseB2cPaymentsRepository(client));
    return NextResponse.json({ assessment });
  } catch {
    return NextResponse.json({ error: "The bank transfer details could not be reviewed. No data was changed." }, { status: 422 });
  }
}
