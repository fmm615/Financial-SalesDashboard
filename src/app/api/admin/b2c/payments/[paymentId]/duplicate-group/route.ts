import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole, getSessionUser } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { B2cPaymentDuplicateRepository } from "@/server/repositories/b2c-payment-duplicate-repository";
import { getB2cPaymentDuplicateReview } from "@/server/services/b2c-payment-duplicate-review";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) {
    return NextResponse.json({ error: "Invalid B2C payment." }, { status: 422 });
  }

  try {
    return NextResponse.json(
      await getB2cPaymentDuplicateReview(paymentId, new B2cPaymentDuplicateRepository(client)),
    );
  } catch {
    return NextResponse.json(
      { error: "Could not load the B2C payment duplicate review." },
      { status: 500 },
    );
  }
}
