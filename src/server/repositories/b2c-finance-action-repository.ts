import type { DatabaseClient } from "@/lib/supabase/server";
import type { B2cFinanceBulkCanonicalDecisionInput } from "@/lib/validation/b2c-finance-action-contracts";

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
}
