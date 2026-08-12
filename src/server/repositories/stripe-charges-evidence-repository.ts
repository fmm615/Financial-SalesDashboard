import type { DatabaseClient } from "@/lib/supabase/server";

export type StripeEvidenceRow = {
  id: string; source_row_number: number; source_entry_key: "primary" | "refund"; transaction_kind: "sale" | "refund" | "needs_review";
  provider_payment_id: string | null; occurred_at: string | null; occurred_at_raw: string | null; original_currency: string;
  credit_amount: string | null; debit_amount: string | null; customer_name: string | null; customer_email: string | null; customer_phone: string | null; description_raw: string | null;
};

export class StripeChargesEvidenceRepository {
  constructor(private readonly client: DatabaseClient) {}
  async listCompleted(limit: number): Promise<StripeEvidenceRow[]> {
    const { data, error } = await this.client.from("b2c_provider_evidence")
      .select("id,source_row_number,source_entry_key,transaction_kind,provider_payment_id,occurred_at,occurred_at_raw,original_currency,credit_amount,debit_amount,customer_name,customer_email,customer_phone,description_raw,b2c_finance_imports!inner(source_kind,import_status)")
      .eq("provider", "stripe").eq("b2c_finance_imports.source_kind", "stripe_charges").eq("b2c_finance_imports.import_status", "completed")
      .order("source_row_number", { ascending: true }).order("source_entry_key", { ascending: true }).limit(limit);
    if (error) throw new Error("Could not load staged Stripe Charges evidence.");
    return (data ?? []) as StripeEvidenceRow[];
  }
}
