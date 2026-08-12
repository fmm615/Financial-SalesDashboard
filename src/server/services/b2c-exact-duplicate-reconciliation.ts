export type ExactFinanceRow = {
  id: string;
  importId: string;
  sourceTab: "B2C" | "B2C Cons";
  quality: "valid" | "zero_value" | "needs_review" | "invalid";
  occurredOn: string | null;
  amountUsd: string | null;
  category: string | null;
  paymentMethod: string | null;
  normalizedCustomerName: string | null;
  normalizedCustomerEmail: string | null;
  normalizedCustomerPhone: string | null;
};

/** Returns true only for one fully matching, cross-tab Finance candidate pair. */
export function isExactFinanceCrossTabPair(left: ExactFinanceRow, right: ExactFinanceRow): boolean {
  if (left.importId !== right.importId || left.quality !== "valid" || right.quality !== "valid") return false;
  if (new Set([left.sourceTab, right.sourceTab]).size !== 2) return false;
  if (!left.occurredOn || !left.amountUsd || !left.paymentMethod || !left.normalizedCustomerName) return false;
  if (left.occurredOn !== right.occurredOn || left.amountUsd !== right.amountUsd
    || left.paymentMethod !== right.paymentMethod) return false;
  return left.normalizedCustomerName === right.normalizedCustomerName;
}

/** Multiple same-key rows are ambiguous and cannot be automatically grouped. */
export function isUnambiguousExactFinanceKey(rows: ExactFinanceRow[]): boolean {
  return rows.length === 2 && isExactFinanceCrossTabPair(rows[0], rows[1]);
}
