import type { DatabaseClient } from "@/lib/supabase/server";
import type {
  B2cFinanceBulkCanonicalDecisionInput,
  B2cFinanceDateAuthorityInput,
  B2cFinanceRowCorrectionInput,
  B2cFinanceSelectedDuplicateDecisionInput,
} from "@/lib/validation/b2c-finance-action-contracts";
import type {
  B2cFinanceDuplicateCandidate,
  B2cFinanceNeedsReviewRow,
} from "@/server/services/b2c-finance-action-center";

type PendingDuplicateGroupRecord = {
  id: string;
  reconciliation_state: "exact_duplicate_candidate";
  b2c_reconciliation_finance_rows: Array<{
    finance_row_id: string;
    b2c_finance_staging_rows: {
      source_tab: "B2C" | "B2C Cons";
      customer_name_raw: string | null;
      customer_email_raw: string | null;
      customer_phone_raw: string | null;
      category_raw: string | null;
      membership_type_raw: string | null;
      payment_status_raw: string | null;
      note_raw: string | null;
    } | null;
  }>;
};

/** Database boundary for high-confidence Finance duplicate decisions. */
export class B2cFinanceActionRepository {
  constructor(private readonly client: DatabaseClient) {}

  async applyBulkCanonicalDecision(input: B2cFinanceBulkCanonicalDecisionInput): Promise<number> {
    const { data, error } = await this.client.rpc("apply_b2c_finance_bulk_canonical_decision", {
      p_group_ids: input.groupIds,
      p_source_tab: input.sourceTab,
      p_reason: input.reason,
    });
    if (error || typeof data !== "number" || data < 0) {
      throw new Error("Could not save the B2C Finance duplicate decisions.");
    }
    return data;
  }

  async applySelectedDuplicateDecisions(input: B2cFinanceSelectedDuplicateDecisionInput): Promise<number> {
    const { data, error } = await this.client.rpc("apply_b2c_finance_selected_duplicate_decisions", {
      p_decisions: input.decisions,
      p_reason: input.reason,
    });
    if (error || typeof data !== "number" || data < 0) {
      throw new Error("Could not save the selected B2C Finance duplicate decisions.");
    }
    return data;
  }

  async listPendingExactDuplicateGroups(): Promise<B2cFinanceDuplicateCandidate[]> {
    const { data, error } = await this.client.from("b2c_reconciliation_groups")
      .select("id,reconciliation_state,b2c_reconciliation_finance_rows(finance_row_id,b2c_finance_staging_rows(source_tab,customer_name_raw,customer_email_raw,customer_phone_raw,category_raw,membership_type_raw,payment_status_raw,note_raw))")
      .eq("reconciliation_state", "exact_duplicate_candidate");
    if (error) throw new Error("Could not load B2C Finance duplicate actions.");

    return ((data ?? []) as unknown as PendingDuplicateGroupRecord[]).flatMap((group) => {
      const rows = group.b2c_reconciliation_finance_rows.flatMap((link) => {
        const row = link.b2c_finance_staging_rows;
        return row ? [{
          financeRowId: link.finance_row_id,
          sourceTab: row.source_tab,
          customerName: row.customer_name_raw,
          customerEmail: row.customer_email_raw,
          customerPhone: row.customer_phone_raw,
          category: row.category_raw,
          membershipType: row.membership_type_raw,
          paymentStatus: row.payment_status_raw,
          note: row.note_raw,
        }] : [];
      });
      return rows.length === 2 ? [{ groupId: group.id, state: group.reconciliation_state, rows }] : [];
    });
  }

  async listNeedsReviewRows(): Promise<B2cFinanceNeedsReviewRow[]> {
    const { data, error } = await this.client.from("b2c_finance_staging_rows")
      .select("id,source_tab,source_row_number,occurred_on,quality_issues,b2c_finance_imports!inner(import_status)")
      .eq("row_quality", "needs_review")
      .eq("b2c_finance_imports.import_status", "completed");
    if (error) throw new Error("Could not load B2C Finance data-quality actions.");

    return (data ?? []).flatMap((row) => {
      const issues = Array.isArray(row.quality_issues) && row.quality_issues.every((issue) => typeof issue === "string")
        ? row.quality_issues : [];
      return [{
        financeRowId: row.id,
        sourceTab: row.source_tab,
        sourceRowNumber: row.source_row_number,
        occurredOn: row.occurred_on,
        qualityIssues: issues,
      }];
    });
  }

  async countPostedFinancePayments(): Promise<number> {
    const { count, error } = await this.client.from("b2c_finance_ledger_posts").select("id", { count: "exact", head: true });
    if (error || count === null || count < 0) throw new Error("Could not count posted B2C Finance payments.");
    return count;
  }

  async applyDateAuthority(input: B2cFinanceDateAuthorityInput): Promise<number> {
    const { data, error } = await this.client.rpc("apply_b2c_finance_date_authority", {
      p_finance_row_ids: input.financeRowIds,
      p_reason: input.reason,
    });
    if (error || typeof data !== "number" || data < 0) throw new Error("Could not confirm B2C Finance dates.");
    return data;
  }

  async applyRowCorrection(financeRowId: string, input: B2cFinanceRowCorrectionInput): Promise<void> {
    const { error } = await this.client.rpc("apply_b2c_finance_row_correction", {
      p_finance_row_id: financeRowId,
      p_occurred_on: input.occurredOn ?? null,
      p_amount_usd: input.amountUsd ?? null,
      p_customer_name: input.customerName ?? null,
      p_category_raw: input.category ?? null,
      p_reason: input.reason,
    });
    if (error) throw new Error("Could not save the B2C Finance correction.");
  }
}
