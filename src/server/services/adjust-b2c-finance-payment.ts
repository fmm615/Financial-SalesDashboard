import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "@/lib/supabase/server";
import type { PostedFinanceAdjustmentRequest } from "@/lib/validation/b2c-posted-adjustment-contracts";

export type { PostedFinanceAdjustmentRequest };

/** A posted B2C Finance payment could not be read or adjusted; no source data was changed. */
export class B2cPostedFinanceAdjustmentUnavailableError extends Error {}

export type B2cPostedFinanceAdjustmentHistoryEntry = {
  id: string;
  adjustmentRequestId: string;
  entryIndex: number;
  adjustmentKind: "amount_correction" | "date_reclassification" | "amount_and_date_correction";
  amountDeltaUsd: string;
  occurredOn: string;
  reason: string;
  createdAt: string;
};

export type B2cPostedFinanceAdjustmentContext = {
  paymentId: string;
  /** The current effective (post-adjustment) posted balance, recomputed the same way the database RPC computes it. */
  currentAmountUsd: string;
  currentOccurredOn: string;
  /** Every previously applied append-only adjustment entry, oldest first. Never editable, only ever added to. */
  history: B2cPostedFinanceAdjustmentHistoryEntry[];
};

type PaymentEligibilityRow = {
  id: string;
  source_system: string;
  payment_status: string;
  original_currency: string;
  amount_usd: string | null;
  occurred_on: string;
};

type AdjustmentRow = {
  id: string;
  adjustment_request_id: string;
  entry_index: number;
  adjustment_kind: "amount_correction" | "date_reclassification" | "amount_and_date_correction";
  amount_delta_usd: string;
  occurred_on: string;
  reason: string;
  created_at: string;
};

/**
 * Replays the original posted payment plus every append-only adjustment entry
 * into the same "one effective balance per business date" grouping the
 * database RPC performs, purely for read-only display before confirmation.
 * The actual write always goes back through the RPC, which independently
 * recomputes and validates this same balance -- a stale or divergent read
 * here can only cause a rejected write, never an incorrect one.
 */
export function computeB2cPostedFinanceEffectiveState(
  originalAmountUsd: string,
  originalOccurredOn: string,
  history: B2cPostedFinanceAdjustmentHistoryEntry[],
): { amountUsd: string; occurredOn: string } | null {
  const balanceByDate = new Map<string, number>();
  balanceByDate.set(originalOccurredOn, (balanceByDate.get(originalOccurredOn) ?? 0) + Number(originalAmountUsd));
  for (const entry of history) {
    balanceByDate.set(entry.occurredOn, (balanceByDate.get(entry.occurredOn) ?? 0) + Number(entry.amountDeltaUsd));
  }
  const nonZero = [...balanceByDate.entries()].filter(([, amount]) => amount !== 0);
  if (nonZero.length !== 1) return null;
  const [occurredOn, amount] = nonZero[0];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amountUsd: amount.toFixed(6), occurredOn };
}

/**
 * Builds the service + route layer around the existing, already-tested
 * `apply_b2c_finance_posted_adjustment_with_expected_state` database RPC
 * (see supabase/migrations/20260817120000_b2c_finance_posted_ledger_adjustments.sql
 * and 20260817122000_b2c_finance_adjustment_concurrency_and_paging.sql). This
 * service never writes an adjustment row itself and never bypasses the RPC's
 * expected-state check; it only looks up the `finance_row_id` the RPC needs
 * and reads back the append-only history for display.
 */
export class SupabaseB2cFinancePaymentAdjustmentService {
  constructor(private readonly client: DatabaseClient) {}

  private async loadFinanceRowId(paymentId: string): Promise<string> {
    const { data: post, error } = await this.client
      .from("b2c_finance_ledger_posts")
      .select("finance_row_id")
      .eq("payment_id", paymentId)
      .maybeSingle();
    if (error || !post) throw new B2cPostedFinanceAdjustmentUnavailableError("This B2C Finance payment has not been posted.");
    return post.finance_row_id;
  }

  private async loadHistory(paymentId: string): Promise<B2cPostedFinanceAdjustmentHistoryEntry[]> {
    const { data, error } = await this.client
      .from("b2c_finance_ledger_adjustments")
      .select("id,adjustment_request_id,entry_index,adjustment_kind,amount_delta_usd,occurred_on,reason,created_at")
      .eq("payment_id", paymentId)
      .order("created_at", { ascending: true })
      .order("entry_index", { ascending: true });
    if (error) throw new B2cPostedFinanceAdjustmentUnavailableError("Could not load the B2C Finance adjustment history.");
    return ((data ?? []) as AdjustmentRow[]).map((row) => ({
      id: row.id,
      adjustmentRequestId: row.adjustment_request_id,
      entryIndex: row.entry_index,
      adjustmentKind: row.adjustment_kind,
      amountDeltaUsd: String(row.amount_delta_usd),
      occurredOn: row.occurred_on,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /** Loads the current effective state and audit history for a posted Finance Tracker payment, before any confirmation. */
  async loadContext(paymentId: string): Promise<B2cPostedFinanceAdjustmentContext> {
    const { data: payment, error: paymentError } = await this.client
      .from("b2c_payments")
      .select("id,source_system,payment_status,original_currency,amount_usd,occurred_on")
      .eq("id", paymentId)
      .maybeSingle();
    const eligiblePayment = payment as PaymentEligibilityRow | null;
    if (paymentError || !eligiblePayment) throw new B2cPostedFinanceAdjustmentUnavailableError("This B2C Finance payment is unavailable.");
    if (
      eligiblePayment.source_system !== "finance_tracker"
      || eligiblePayment.payment_status !== "succeeded"
      || eligiblePayment.original_currency !== "USD"
      || eligiblePayment.amount_usd === null
    ) {
      throw new B2cPostedFinanceAdjustmentUnavailableError("Only a posted, complete USD Payment Tracker payment can be adjusted.");
    }

    // A finance_tracker payment only ever exists because it was posted, but
    // this check is cheap and keeps the read symmetric with `apply`, which
    // must look up the same finance_row_id before calling the RPC.
    await this.loadFinanceRowId(paymentId);

    const history = await this.loadHistory(paymentId);
    const effective = computeB2cPostedFinanceEffectiveState(String(eligiblePayment.amount_usd), eligiblePayment.occurred_on, history);
    if (!effective) throw new B2cPostedFinanceAdjustmentUnavailableError("The current posted B2C Finance balance needs review before another adjustment.");

    return { paymentId, currentAmountUsd: effective.amountUsd, currentOccurredOn: effective.occurredOn, history };
  }

  /**
   * Applies a verified correction. The browser never sends a signed/computed
   * adjustment row -- only the values it believes are currently true (guarded
   * server-side and again by the RPC's own expected-state check) and the
   * corrected value(s). The server generates a fresh idempotency key per
   * request and always calls the expected-state RPC, never the unguarded one.
   */
  async apply(paymentId: string, request: PostedFinanceAdjustmentRequest): Promise<{ insertedEntries: number }> {
    const financeRowId = await this.loadFinanceRowId(paymentId);
    const { data, error } = await this.client.rpc("apply_b2c_finance_posted_adjustment_with_expected_state", {
      p_finance_row_id: financeRowId,
      p_occurred_on: request.verifiedOccurredOn ?? null,
      p_amount_usd: request.verifiedAmountUsd ?? null,
      p_customer_name: null,
      p_category_raw: null,
      p_adjustment_request_id: randomUUID(),
      p_reason: request.reason,
      p_expected_amount_usd: request.expectedAmountUsd,
      p_expected_occurred_on: request.expectedOccurredOn,
    });
    if (error || typeof data !== "number") {
      throw new B2cPostedFinanceAdjustmentUnavailableError(
        "This B2C Finance payment could not be adjusted. Reload it and try again.",
      );
    }
    return { insertedEntries: data };
  }
}
