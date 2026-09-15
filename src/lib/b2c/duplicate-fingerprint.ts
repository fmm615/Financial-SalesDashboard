import { createHash } from "node:crypto";

/**
 * Matches B2C content within 48 hours without storing raw provider payloads.
 * A record with no source email cannot pass the content check, so its provider
 * ID makes a one-record placeholder fingerprint until an Admin reviews it.
 *
 * The inputs are customer email, USD amount, and business date. This formula is
 * duplicated in PostgreSQL by get_effective_b2c_duplicate_facts and by
 * record_b2c_manual_bank_transfer (see
 * supabase/migrations/20270101000500_remove_b2c_category.sql) -- change every
 * copy together or tests/b2c-hash-parity.test.ts fails.
 */
export function createB2cDuplicateFingerprint(input: { customerEmail: string | null; amountUsd: string; originalCurrency?: string; occurredOn: string; providerTransactionId: string }): string {
  const identity = input.customerEmail?.trim().toLowerCase() || `missing-email:${input.providerTransactionId}`;
  const [whole, fraction = ""] = input.amountUsd.trim().split(".");
  const canonicalAmount = `${whole}.${fraction.padEnd(6, "0").slice(0, 6)}`;
  const currency = input.originalCurrency?.trim().toUpperCase() || "USD";
  return createHash("sha256").update(`${identity}|${currency}|${canonicalAmount}|${input.occurredOn}`, "utf8").digest("hex");
}
