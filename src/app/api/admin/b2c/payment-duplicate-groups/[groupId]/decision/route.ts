import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole, getSessionUser } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cPaymentDuplicateDecisionSchema } from "@/lib/validation/b2c-payment-duplicate-contracts";
import { B2cPaymentDuplicateRepository } from "@/server/repositories/b2c-payment-duplicate-repository";
import { toB2cPaymentDuplicateGroupReview } from "@/server/services/b2c-payment-duplicate-review";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const { groupId } = await params;
  if (!z.string().uuid().safeParse(groupId).success) {
    return NextResponse.json({ error: "Invalid B2C payment duplicate group." }, { status: 422 });
  }

  const parsed = b2cPaymentDuplicateDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid B2C payment duplicate decision." }, { status: 422 });
  }

  let resolvedPaymentIds: string[];
  try {
    const openGroup = await new B2cPaymentDuplicateRepository(client).getOpenGroup(groupId);
    if (!openGroup) {
      return NextResponse.json(
        { error: "This B2C payment duplicate group is unavailable or already resolved." },
        { status: 404 },
      );
    }
    resolvedPaymentIds = toB2cPaymentDuplicateGroupReview(openGroup).members
      .map((member) => member.paymentId);
  } catch {
    return NextResponse.json(
      { error: "Could not load the B2C payment duplicate group." },
      { status: 500 },
    );
  }

  let rpcError: unknown;
  try {
    const result = await client.rpc("resolve_b2c_payment_duplicate_group", {
      p_group_id: groupId,
      p_decision: parsed.data.decision,
      p_canonical_payment_id: parsed.data.canonicalPaymentId,
      p_reason: parsed.data.reason,
    });
    rpcError = result.error;
  } catch {
    rpcError = true;
  }

  if (rpcError) {
    return NextResponse.json(
      { error: "The B2C payment duplicate decision could not be saved." },
      { status: 422 },
    );
  }
  return NextResponse.json({ groupId, resolvedPaymentIds }, { status: 201 });
}
