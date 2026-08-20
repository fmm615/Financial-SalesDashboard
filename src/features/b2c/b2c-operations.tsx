import { B2cWorkspace } from "@/features/b2c/b2c-workspace";
import type { B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";

/**
 * Thin bridge kept for a stable export name: `/operations/b2c/page.tsx`
 * fetches the server-side dashboard snapshot (period totals, coverage, and
 * the four header values) and hands it to the client `B2cWorkspace`, which
 * separately loads its own Work queue/Ledger/Sources tab content from
 * `/api/b2c/workspace`. See "Final B2C UI Inventory" in
 * docs/superpowers/plans/2026-08-18-b2c-single-control-flow.md.
 */
export function B2cOperations({
  snapshot = null,
  loadError,
  initialTapStatementUnmatchedOnly = false,
}: {
  snapshot?: B2cDashboardSnapshot | null;
  loadError?: string;
  initialTapStatementUnmatchedOnly?: boolean;
}) {
  return <B2cWorkspace snapshot={snapshot} loadError={loadError} initialTapStatementUnmatchedOnly={initialTapStatementUnmatchedOnly} />;
}
