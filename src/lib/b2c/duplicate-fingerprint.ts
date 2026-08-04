import { createHash } from "node:crypto";

/** Matches B2C content within 48 hours without storing raw provider payloads. */
export function createB2cDuplicateFingerprint(input: { customerEmail: string; amountUsd: string; categoryCode: string; occurredOn: string }): string {
  return createHash("sha256").update(`${input.customerEmail.trim().toLowerCase()}|${input.amountUsd}|${input.categoryCode.trim().toLowerCase()}|${input.occurredOn}`, "utf8").digest("hex");
}
