import { B2cOperations } from "@/features/b2c/b2c-operations";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getB2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

export default async function B2cPage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const requestedPeriod = (await searchParams).period;
  const selectedPeriod = typeof requestedPeriod === "string" ? requestedPeriod : undefined;
  try {
    const client = await createServerSupabaseClient();
    return <B2cOperations snapshot={await getB2cDashboardSnapshot(client, new Date(), selectedPeriod)} />;
  } catch {
    return <B2cOperations snapshot={null} loadError="B2C source records could not be loaded. Check that the required database migration has been applied." />;
  }
}
