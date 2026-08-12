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

  async createExactDuplicateGroups(): Promise<number> {
    const { data, error } = await this.client.rpc("create_b2c_exact_duplicate_groups", {});
    if (error || typeof data !== "number" || data < 0) throw new Error("Could not create exact B2C Finance duplicate groups.");
    return data;
  }

  async listPendingExactDuplicateGroups(): Promise<ExactDuplicateGroupRow[]> {
    const { data, error } = await this.client.from("b2c_reconciliation_groups")
      .select("id,reconciliation_state,b2c_reconciliation_finance_rows(finance_row_id,b2c_finance_staging_rows(source_tab,source_row_number,occurred_on,amount_usd,customer_name_raw,customer_email_raw,customer_phone_raw,category_raw,payment_method_raw))")
      .eq("reconciliation_state", "exact_duplicate_candidate");
    if (error) throw new Error("Could not load exact B2C Finance duplicate groups.");
    return (data ?? []) as unknown as ExactDuplicateGroupRow[];
  }
}
