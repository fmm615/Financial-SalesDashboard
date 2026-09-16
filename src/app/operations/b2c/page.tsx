import { B2cOperations } from "@/features/b2c/b2c-operations";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getB2cDashboardSummary } from "@/server/repositories/b2c-dashboard-repository";

export default async function B2cPage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const params = await searchParams;
  const requestedPeriod = params.period;
  const selectedPeriod = typeof requestedPeriod === "string" ? requestedPeriod : undefined;
  try {
    const client = await createServerSupabaseClient();
    const snapshot = await getB2cDashboardSummary(client, new Date(), selectedPeriod);
    return <B2cOperations snapshot={snapshot} />;
  } catch (error) {
    console.error("B2C dashboard snapshot failed to load:", error);
    return <B2cOperations snapshot={null} loadError="B2C source records could not be loaded. Check that the required database migration has been applied." />;
  }
}
