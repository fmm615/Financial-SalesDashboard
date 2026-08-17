import { mapApprovedFinancePostResult, type ApprovedFinancePostResult } from "@/lib/b2c/approved-finance-payment";
import type { DatabaseClient } from "@/lib/supabase/server";

type CodedFailure = Error & { code?: string };

/** Calls the database-owned posting transaction; no Finance or provider rows are built in TypeScript. */
export class SupabaseB2cFinanceLedgerRepository {
  constructor(private readonly client: DatabaseClient) {}

  async postApprovedFinancePayments(): Promise<ApprovedFinancePostResult> {
    const { data, error } = await this.client.rpc("post_approved_b2c_finance_payments", {});
    const result = Array.isArray(data) && data.length === 1 ? mapApprovedFinancePostResult(data[0]) : null;
    if (error) {
      const failure = new Error("Could not post approved B2C Finance payments.") as CodedFailure;
      if (typeof error.code === "string") failure.code = error.code;
      throw failure;
    }
    if (!result) throw new Error("Could not post approved B2C Finance payments.");
    return result;
  }
}
