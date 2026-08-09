export type B2cProviderName = "stripe" | "tap";

export type ProviderHistoricalBackfillState = { status: string; recordsFailed: number; completedAt: string | null } | null;
export type ProviderReconciliationState = { status: string; requestedRangeEnd: string | null; completedAt: string | null } | null;
export type B2cProviderCoverageInput = { provider: B2cProviderName; active: boolean; historicalBackfill: ProviderHistoricalBackfillState; latestReconciliation: ProviderReconciliationState };

export type B2cSourceCoverage = {
  reportingTotalsReady: boolean;
  state: "ready" | "incomplete" | "not_loaded";
  dataAsOf: string | null;
  title: string;
  description: string;
};

function laterTimestamp(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return first >= second ? first : second;
}
function label(provider: B2cProviderName): string { return provider === "stripe" ? "Stripe" : "Tap"; }

/** Financial totals are only complete after every active B2C source's clean, full local history import. */
export function resolveB2cSourceCoverage(input: { providers: B2cProviderCoverageInput[] }): B2cSourceCoverage {
  const active = input.providers.filter((provider) => provider.active);
  const dataAsOf = active.reduce<string | null>((latest, provider) => {
    const reconciliation = provider.latestReconciliation?.status === "completed" ? provider.latestReconciliation.requestedRangeEnd ?? provider.latestReconciliation.completedAt : null;
    return laterTimestamp(latest, laterTimestamp(provider.historicalBackfill?.completedAt ?? null, reconciliation));
  }, null);
  if (!active.length) return { reportingTotalsReady: false, state: "not_loaded", dataAsOf: null, title: "No B2C source history has been loaded", description: "PLAYBOOK will show B2C financial totals after an Admin imports at least one configured provider history." };

  const notLoaded = active.filter((provider) => !provider.historicalBackfill);
  if (notLoaded.length) return { reportingTotalsReady: false, state: "not_loaded", dataAsOf, title: `${notLoaded.map((provider) => label(provider.provider)).join(" and ")} historical data has not been fully loaded`, description: "PLAYBOOK can show retrieved source records, but it withholds combined B2C financial totals until every active provider history is complete." };
  const incomplete = active.filter((provider) => provider.historicalBackfill?.status !== "completed");
  if (incomplete.length) return { reportingTotalsReady: false, state: "incomplete", dataAsOf, title: "Historical B2C import is still in progress", description: `${incomplete.map((provider) => label(provider.provider)).join(" and ")} source history is partial. Financial totals are intentionally withheld until the import finishes.` };
  const failed = active.filter((provider) => (provider.historicalBackfill?.recordsFailed ?? 0) > 0);
  if (failed.length) {
    const count = failed.reduce((sum, provider) => sum + (provider.historicalBackfill?.recordsFailed ?? 0), 0);
    return { reportingTotalsReady: false, state: "incomplete", dataAsOf, title: "Historical B2C import completed with exceptions", description: `${count} source record${count === 1 ? "" : "s"} could not be loaded across ${failed.map((provider) => label(provider.provider)).join(" and ")}. Resolve or retry them before treating B2C totals as complete.` };
  }
  return { reportingTotalsReady: true, state: "ready", dataAsOf, title: "B2C financial totals are ready", description: `The full ${active.map((provider) => label(provider.provider)).join(" and ")} history was loaded without source-record failures. Financial totals include only reportable payments and their linked succeeded refunds.` };
}
