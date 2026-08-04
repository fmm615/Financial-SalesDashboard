import { createHash } from "node:crypto";

/**
 * Matches B2C content within 48 hours without storing raw provider payloads.
 * A record with no source email cannot pass the content check, so its provider
 * ID makes a one-record placeholder fingerprint until an Admin reviews it.
 */
export function createB2cDuplicateFingerprint(input: { customerEmail: string | null; amountUsd: string; categoryCode: string; occurredOn: string; providerTransactionId: string }): string {
  const identity = input.customerEmail?.trim().toLowerCase() || `missing-email:${input.providerTransactionId}`;
  return createHash("sha256").update(`${identity}|${input.amountUsd}|${input.categoryCode.trim().toLowerCase()}|${input.occurredOn}`, "utf8").digest("hex");
}
