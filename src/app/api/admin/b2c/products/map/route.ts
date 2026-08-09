import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { b2cProductMappingSchema } from "@/lib/validation/financial-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Saves an audited PLAYBOOK-only product classification; it never calls a provider. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = b2cProductMappingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid product mapping." }, { status: 422 });

  const { error } = await client.rpc("apply_b2c_product_mapping", {
    p_source_system: parsed.data.sourceSystem,
    p_external_product_id: parsed.data.productReference,
    p_internal_product_code: parsed.data.internalProductCode,
    p_internal_product_name: parsed.data.internalProductName,
    p_category_code: parsed.data.categoryCode,
    p_membership_tier: parsed.data.membershipTier?.trim() || null,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The local provider product mapping could not be saved." }, { status: 422 });
  return NextResponse.json({ ok: true });
}
