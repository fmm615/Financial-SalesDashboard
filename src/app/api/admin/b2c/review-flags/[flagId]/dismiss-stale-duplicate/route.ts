import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cPaymentDuplicateStaleDismissalSchema } from "@/lib/validation/b2c-payment-duplicate-contracts";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ flagId: string }> },
) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || requireMiddlewareRole(request) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { flagId } = await params;
  if (!z.string().uuid().safeParse(flagId).success) {
    return NextResponse.json({ error: "Invalid B2C review item." }, { status: 422 });
  }

  const parsed = b2cPaymentDuplicateStaleDismissalSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid stale duplicate dismissal." }, { status: 422 });
  }

  let rpcError: unknown;
  try {
    const result = await client.rpc("dismiss_stale_b2c_possible_duplicate_flag", {
      p_flag_id: flagId,
      p_reason: parsed.data.reason,
    });
    rpcError = result.error;
  } catch {
    rpcError = true;
  }

  if (rpcError) {
    return NextResponse.json(
      { error: "The stale B2C possible-duplicate review item could not be dismissed." },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true });
}
