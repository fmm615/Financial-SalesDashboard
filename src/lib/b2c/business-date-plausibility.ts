/**
 * A B2C business date always records a payment that already happened, so a
 * date more than one day past `today` is never plausible. Checked whenever
 * any B2C record's decision is resolved -- including an already-posted
 * payment, so a date that only became implausible after the fact is still
 * caught on every later read.
 */
const FUTURE_DATE_GRACE_DAYS = 1;

export function isImplausibleFutureBusinessDate(occurredOn: string, today: Date): boolean {
  const latestPlausible = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + FUTURE_DATE_GRACE_DAYS));
  return occurredOn > latestPlausible.toISOString().slice(0, 10);
}
