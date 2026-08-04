import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { firstValidationMessage, manualRecognisedSaleSchema } from "@/lib/validation/financial-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseB2bRecognisedSalesRepository } from "@/server/repositories/b2b-recognised-sales-repository";
import { recordManualRecognisedSale } from "@/server/services/record-manual-recognised-sale";

/** Records an Admin-entered recognised-sale row locally; HubSpot is never called. */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = manualRecognisedSaleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstValidationMessage(parsed.error) }, { status: 422 });
  }

  try {
    const sale = await recordManualRecognisedSale(parsed.data, new SupabaseB2bRecognisedSalesRepository(client));
    return NextResponse.json({ saleId: sale.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Recognised sales cannot exceed the linked deal USD amount")) {
      return NextResponse.json({ error: "The recognised-sales total cannot exceed this deal's USD amount. Correct the deal locally first if its approved value changed." }, { status: 422 });
    }
    return NextResponse.json({ error: "The recognised-sales entry could not be saved." }, { status: 422 });
  }
}
