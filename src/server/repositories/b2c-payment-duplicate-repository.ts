import type { DatabaseClient } from "@/lib/supabase/server";

type B2cPaymentSourceSystem = "stripe" | "tap" | "manual_bank_transfer" | "finance_tracker";

export type B2cPaymentDuplicatePaymentRow = {
  id: string;
  source_system: B2cPaymentSourceSystem;
  provider_transaction_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  original_amount: string;
  original_currency: string;
  amount_usd: string | null;
  occurred_on: string | null;
  payment_status: "succeeded" | "failed" | "pending";
  local_override: {
    customer_name: string | null;
    customer_email: string | null;
    local_amount_usd: string | null;
    local_occurred_on: string | null;
  } | null;
};

export type B2cPaymentDuplicateGroupRow = {
  id: string;
  detection_reason: string;
  members: Array<{
    payment_id: string;
    payment: B2cPaymentDuplicatePaymentRow | null;
  }>;
};

type OpenGroupQueryRow = B2cPaymentDuplicateGroupRow & {
  target_members?: Array<{ payment_id: string }>;
};

const openGroupSelection = `
  id,
  detection_reason,
  target_members:b2c_payment_duplicate_group_members!inner(payment_id),
  members:b2c_payment_duplicate_group_members(
    payment_id,
    payment:b2c_payments!inner(
      id,
      source_system,
      provider_transaction_id,
      customer_name,
      customer_email,
      original_amount,
      original_currency,
      amount_usd,
      occurred_on,
      payment_status,
      local_override:b2c_payment_local_overrides(
        customer_name,
        customer_email,
        local_amount_usd,
        local_occurred_on
      )
    )
  )
`;

export class B2cPaymentDuplicateRepository {
  constructor(private readonly client: DatabaseClient) {}

  async getOpenGroupForPayment(paymentId: string): Promise<B2cPaymentDuplicateGroupRow | null> {
    const { data, error } = await this.client
      .from("b2c_payment_duplicate_groups")
      .select(openGroupSelection)
      .eq("status", "open")
      .eq("target_members.payment_id", paymentId)
      .limit(2);

    if (error) throw new Error("Could not load the B2C payment duplicate group.");
    const rows = (data ?? []) as unknown as OpenGroupQueryRow[];
    if (rows.length > 1) throw new Error("B2C payment duplicate group database invariant failed.");
    return rows[0] ? this.withoutTargetMembership(rows[0]) : null;
  }

  async getOpenGroup(groupId: string): Promise<B2cPaymentDuplicateGroupRow | null> {
    const { data, error } = await this.client
      .from("b2c_payment_duplicate_groups")
      .select(openGroupSelection)
      .eq("status", "open")
      .eq("id", groupId)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error("Could not load the B2C payment duplicate group.");
    return data ? this.withoutTargetMembership(data as unknown as OpenGroupQueryRow) : null;
  }

  async getOpenPossibleDuplicateFlagForPayment(paymentId: string): Promise<{ id: string } | null> {
    const { data, error } = await this.client
      .from("review_flags")
      .select("id")
      .eq("source_area", "b2c_payment")
      .eq("source_record_id", paymentId)
      .eq("flag_type", "possible_duplicate")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();

    if (error) throw new Error("Could not load the B2C payment duplicate review item.");
    return data ? { id: data.id } : null;
  }

  private withoutTargetMembership(row: OpenGroupQueryRow): B2cPaymentDuplicateGroupRow {
    return {
      id: row.id,
      detection_reason: row.detection_reason,
      members: row.members,
    };
  }
}
