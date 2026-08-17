import { NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { B2cFinanceActionRepository } from "@/server/repositories/b2c-finance-action-repository";
import { createB2cFinanceActionCenter } from "@/server/services/b2c-finance-action-center";

/** Returns a safe, plain-language overview of B2C Finance work requiring an Admin decision. */
export async function GET() {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || await getApprovedRole(client, user.id) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  try {
    const overview = await createB2cFinanceActionCenter(new B2cFinanceActionRepository(client)).overview();
    return NextResponse.json({ overview });
  } catch {
    return NextResponse.json({ error: "Could not load B2C Finance actions." }, { status: 500 });
  }
}
