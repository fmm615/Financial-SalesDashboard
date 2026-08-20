import { B2cOperations } from "@/features/b2c/b2c-operations";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getB2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

export default async function B2cPage({ searchParams }: { searchParams: Promise<{ period?: string | string[]; review?: string | string[] }> }) {
  const params = await searchParams;
  const requestedPeriod = params.period;
  const selectedPeriod = typeof requestedPeriod === "string" ? requestedPeriod : undefined;
  const showTapStatementUnmatched = params.review === "tap_statement_unmatched";
  try {
    const client = await createServerSupabaseClient();
    const snapshot = await getB2cDashboardSnapshot(client, new Date(), selectedPeriod);
    // `snapshot.rows` (which carries Admin-only Stripe evidence) is never read
    // by `B2cWorkspace` -- its ledger rows come only from the Viewer-safe
    // `/api/b2c/workspace` fetch. Every viewer's role, this server component
    // renders once and hands its props to a client component, so any field
    // here still serializes into the page payload. Stripping `rows` keeps
    // Admin-only evidence out of that payload for every role, matching the
    // shared drawer's own dedicated Admin-only evidence read.
    return <B2cOperations snapshot={{ ...snapshot, rows: [] }} initialTapStatementUnmatchedOnly={showTapStatementUnmatched} />;
  } catch {
    return <B2cOperations snapshot={null} loadError="B2C source records could not be loaded. Check that the required database migration has been applied." />;
  }
}
