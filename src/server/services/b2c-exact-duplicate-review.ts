import type { ExactDuplicateGroupRow } from "@/server/repositories/b2c-exact-duplicate-reconciliation-repository";

export type AdminExactDuplicateGroup = {
  groupId: string;
  state: "exact_duplicate_candidate";
  rows: Array<{
    financeRowId: string;
    sourceTab: "B2C" | "B2C Cons";
    sourceRowNumber: number;
    occurredOn: string;
    amountUsd: string;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    category: string;
    paymentMethod: string;
  }>;
};

/** Maps Admin-authorised database rows to the smallest review model needed by the UI. */
export function toAdminExactDuplicateGroups(rows: ExactDuplicateGroupRow[]): AdminExactDuplicateGroup[] {
  return rows.flatMap((group) => {
    const reviewRows = group.b2c_reconciliation_finance_rows.flatMap((link) => {
      const row = link.b2c_finance_staging_rows;
      if (!row || !row.occurred_on || !row.amount_usd || !row.category_raw || !row.payment_method_raw) return [];
      return [{
        financeRowId: link.finance_row_id,
        sourceTab: row.source_tab,
        sourceRowNumber: row.source_row_number,
        occurredOn: row.occurred_on,
        amountUsd: row.amount_usd,
        customerName: row.customer_name_raw,
        customerEmail: row.customer_email_raw,
        customerPhone: row.customer_phone_raw,
        category: row.category_raw,
        paymentMethod: row.payment_method_raw,
      }];
    }).sort((left, right) => left.sourceTab.localeCompare(right.sourceTab));
    return reviewRows.length === 2
      ? [{ groupId: group.id, state: group.reconciliation_state, rows: reviewRows }]
      : [];
  });
}
