import type { DatabaseClient } from "@/lib/supabase/server";

export type ExactDuplicateGroupRow = {
  id: string;
  reconciliation_state: "exact_duplicate_candidate";
  b2c_reconciliation_finance_rows: Array<{
    finance_row_id: string;
    b2c_finance_staging_rows: {
      source_tab: "B2C" | "B2C Cons";
      source_row_number: number;
      occurred_on: string | null;
      amount_usd: string | null;
      customer_name_raw: string | null;
      customer_email_raw: string | null;
      customer_phone_raw: string | null;
      category_raw: string | null;
      payment_method_raw: string | null;
    } | null;
  }>;
};

export class B2cExactDuplicateReconciliationRepository {
  constructor(private readonly client: DatabaseClient) {}

  async listPendingExactDuplicateGroups(): Promise<ExactDuplicateGroupRow[]> {
    const groups: ExactDuplicateGroupRow[] = [];
    const pageSize = 500;
    for (let start = 0; ; start += pageSize) {
      const { data, error } = await this.client.from("b2c_reconciliation_groups")
        .select("id,reconciliation_state,b2c_reconciliation_finance_rows(finance_row_id,b2c_finance_staging_rows(source_tab,source_row_number,occurred_on,amount_usd,customer_name_raw,customer_email_raw,customer_phone_raw,category_raw,payment_method_raw))")
        .eq("reconciliation_state", "exact_duplicate_candidate")
        .order("id", { ascending: true })
        .range(start, start + pageSize - 1);
      if (error) throw new Error("Could not load exact B2C Finance duplicate groups.");
      const page = (data ?? []) as unknown as ExactDuplicateGroupRow[];
      groups.push(...page);
      if (page.length < pageSize) return groups;
    }
  }

  async getPendingExactDuplicateGroup(groupId: string): Promise<ExactDuplicateGroupRow | null> {
    const { data, error } = await this.client.from("b2c_reconciliation_groups")
      .select("id,reconciliation_state,b2c_reconciliation_finance_rows(finance_row_id,b2c_finance_staging_rows(source_tab,source_row_number,occurred_on,amount_usd,customer_name_raw,customer_email_raw,customer_phone_raw,category_raw,payment_method_raw))")
      .eq("id", groupId)
      .eq("reconciliation_state", "exact_duplicate_candidate")
      .maybeSingle();
    if (error) throw new Error("Could not load exact B2C Finance duplicate groups.");
    return data as unknown as ExactDuplicateGroupRow | null;
  }
}
