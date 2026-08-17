import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cFinanceRowCorrectionSchema } from "@/lib/validation/b2c-finance-action-contracts";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";

/** Stores a verified local overlay; the uploaded workbook row remains immutable evidence. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }
  const { rowId } = await params;
  if (!z.string().uuid().safeParse(rowId).success) return NextResponse.json({ error: "Invalid B2C Finance row." }, { status: 422 });
  const parsed = b2cFinanceRowCorrectionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid B2C Finance correction." }, { status: 422 });

  try {
    await new B2cFinanceActionRepository(client).applyRowCorrection(rowId, parsed.data);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not save the B2C Finance correction. No source data was changed." }, { status: 422 });
  }
}
