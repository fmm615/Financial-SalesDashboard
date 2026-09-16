import { createHash } from "node:crypto";

/**
 * Matches B2C content within an Admin-configurable time window (default 48
 * hours; see public.b2c_settings.duplicate_detection_window_hours in
 * supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql)
 * without storing raw provider payloads. A record with no source email
 * cannot pass the content check, so its provider ID makes a one-record
 * placeholder fingerprint until an Admin reviews it.
 *
 * This function itself has no time component -- the window is applied by the
 * caller (SupabaseB2cPaymentsRepository.assessManualBankTransferDuplicates in
 * src/server/repositories/b2c-payments-repository.ts) around the fingerprint
 * this produces. The inputs to the fingerprint are customer email, USD
 * amount, and business date. This formula is duplicated in PostgreSQL by
 * get_effective_b2c_duplicate_facts and by record_b2c_manual_bank_transfer
 * (see supabase/migrations/20270101000500_remove_b2c_category.sql) -- change
 * every copy together or tests/b2c-hash-parity.test.ts fails.
 */
export function createB2cDuplicateFingerprint(input: { customerEmail: string | null; amountUsd: string; originalCurrency?: string; occurredOn: string; providerTransactionId: string }): string {
  const identity = input.customerEmail?.trim().toLowerCase() || `missing-email:${input.providerTransactionId}`;
  const [whole, fraction = ""] = input.amountUsd.trim().split(".");
  const canonicalAmount = `${whole}.${fraction.padEnd(6, "0").slice(0, 6)}`;
  const currency = input.originalCurrency?.trim().toUpperCase() || "USD";
  return createHash("sha256").update(`${identity}|${currency}|${canonicalAmount}|${input.occurredOn}`, "utf8").digest("hex");
}
