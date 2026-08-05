export type StripeHistoricalBackfillState = {
  status: string;
  recordsFailed: number;
  completedAt: string | null;
} | null;

export type StripeReconciliationState = {
  status: string;
  requestedRangeEnd: string | null;
  completedAt: string | null;
} | null;

export type B2cSourceCoverage = {
  /** Whether the whole Stripe history has been read without unpersisted source failures. */
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

/**
 * A retrieved Stripe row is not proof that a reporting period is complete.
 * Financial totals are available only after the resumable historical import
 * finished without source-record failures. Routine reconciliation can then
 * advance the transparent "as of" timestamp; it never changes Stripe.
 */
export function resolveB2cSourceCoverage(input: {
  historicalBackfill: StripeHistoricalBackfillState;
  latestReconciliation: StripeReconciliationState;
}): B2cSourceCoverage {
  const historical = input.historicalBackfill;
  const reconciliationAsOf = input.latestReconciliation?.status === "completed"
    ? input.latestReconciliation.requestedRangeEnd ?? input.latestReconciliation.completedAt
    : null;
  const dataAsOf = laterTimestamp(historical?.completedAt ?? null, reconciliationAsOf);

  if (!historical) {
    return {
      reportingTotalsReady: false,
      state: "not_loaded",
      dataAsOf: null,
      title: "Historical Stripe data has not been fully loaded",
      description: "PLAYBOOK can show retrieved source records, but it withholds financial totals until the full historical Stripe import completes.",
    };
  }

  if (historical.status !== "completed") {
    return {
      reportingTotalsReady: false,
      state: "incomplete",
      dataAsOf,
      title: "Historical Stripe import is still in progress",
      description: "The source ledger is partial. Financial totals are intentionally withheld until the import finishes.",
    };
  }

  if (historical.recordsFailed > 0) {
    return {
      reportingTotalsReady: false,
      state: "incomplete",
      dataAsOf,
      title: "Historical Stripe import completed with exceptions",
      description: `${historical.recordsFailed} source record${historical.recordsFailed === 1 ? "" : "s"} could not be loaded. Resolve or retry those records before treating B2C totals as complete.`,
    };
  }

  return {
    reportingTotalsReady: true,
    state: "ready",
    dataAsOf,
    title: "B2C financial totals are ready",
    description: "The full Stripe history was loaded without source-record failures. Financial totals include only reportable payments and their linked succeeded refunds.",
  };
}
