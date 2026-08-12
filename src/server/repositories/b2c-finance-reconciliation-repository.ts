import type { DatabaseClient } from "@/lib/supabase/server";
import type { FinanceImportRequestInput } from "@/lib/validation/b2c-finance-import-contracts";
import type { FinanceImportAssessment } from "@/server/services/b2c-finance-reconciliation";
import type { Json } from "@/types/database.generated";

export class SupabaseB2cFinanceReconciliationRepository {
  constructor(private readonly client: DatabaseClient) {}

  /** The SQL function persists the import and every staged row in one transaction. */
  async finalizeFinanceImport(input: FinanceImportRequestInput, assessment: FinanceImportAssessment): Promise<string> {
    const sourceRows = input.rows.map((row, index) => {
      const assessed = assessment.rows[index];
      return {
        sourceTab: row.sourceTab,
        sourceRowNumber: row.sourceRowNumber,
        rawPayload: row.rawPayload as Json,
        reportedDateRaw: row.reportedDateRaw,
        declaredMonthRaw: row.declaredMonth ?? null,
        declaredYearRaw: row.declaredYear ?? null,
        amountUsdRaw: row.amountUsdRaw ?? null,
        customerNameRaw: row.customerNameRaw ?? null,
        customerEmailRaw: row.customerEmailRaw ?? null,
        customerPhoneRaw: row.customerPhoneRaw ?? null,
        categoryRaw: row.categoryRaw ?? null,
        membershipTypeRaw: row.membershipTypeRaw ?? null,
        paymentMethodRaw: row.paymentMethodRaw ?? null,
        paymentStatusRaw: row.paymentStatusRaw ?? null,
        noteRaw: row.noteRaw ?? null,
        occurredOn: assessed.occurredOn,
        amountUsd: assessed.amountUsd,
        normalizedCustomerName: assessed.normalizedCustomerName,
        normalizedCustomerEmail: assessed.normalizedCustomerEmail,
        normalizedCustomerPhone: assessed.normalizedCustomerPhone,
        rowQuality: assessed.quality,
        qualityIssues: assessed.issues,
      };
    });
    const { data, error } = await this.client.rpc("finalize_b2c_finance_import", {
      p_source_file_name: input.sourceFileName,
      p_source_file_sha256: input.sourceFileSha256,
      p_source_storage_bucket: input.sourceStorageBucket,
      p_source_storage_path: input.sourceStoragePath,
      p_rows: sourceRows,
    });
    if (error || !data) throw new Error("Could not finalize the B2C Finance import.");
    return data;
  }
}
