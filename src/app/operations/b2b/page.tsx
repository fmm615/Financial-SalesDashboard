import { B2bOperations } from "@/features/b2b/b2b-operations";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getB2bDashboardSnapshot } from "@/server/repositories/b2b-dashboard-repository";

export default async function B2bPage() {
  try {
    const snapshot = await getB2bDashboardSnapshot(await createServerSupabaseClient());
    return <B2bOperations snapshot={snapshot} />;
  } catch {
    return <B2bOperations snapshot={null} loadError="Reportable B2B data could not be loaded. Check that the required database migration has been applied." />;
  }
}
