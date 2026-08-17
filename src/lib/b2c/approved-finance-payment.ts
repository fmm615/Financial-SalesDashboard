export type ApprovedFinancePaymentMethod = "bank_transfer" | "ios";

export type ApprovedFinancePostResult = {
  postedPayments: number;
  alreadyPostedPayments: number;
  skippedRows: number;
};

function normalizedWords(value: string | null | undefined): string | null {
  const words = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return words || null;
}

/** Accepts only the two Finance methods that have row-level evidence in the Payment Tracker. */
export function normalizeApprovedFinancePaymentMethod(value: string | null | undefined): ApprovedFinancePaymentMethod | null {
  const normalized = normalizedWords(value);
  if (normalized === "bank transfer") return "bank_transfer";
  if (normalized === "ios") return "ios";
  return null;
}

/** Retains Finance classification without inventing a category outside the ledger's safe code format. */
export function normalizeFinanceCategoryCode(value: string | null | undefined): string | null {
  const normalized = normalizedWords(value);
  return normalized?.replace(/ /g, "-") ?? null;
}

/** Converts the only supported database result shape to the API-safe application model. */
export function mapApprovedFinancePostResult(value: unknown): ApprovedFinancePostResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const posted = candidate.posted_payments;
  const alreadyPosted = candidate.already_posted_payments;
  const skipped = candidate.skipped_rows;
  if (![posted, alreadyPosted, skipped].every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0)) return null;
  return { postedPayments: posted as number, alreadyPostedPayments: alreadyPosted as number, skippedRows: skipped as number };
}
