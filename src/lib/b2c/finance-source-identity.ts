import { createHash } from "node:crypto";

/**
 * The four fields shared consistently by both Finance workbook tabs. Source
 * tab, category, staging UUID, and file hash are deliberately excluded
 * because `B2C` and `B2C Cons` do not share equivalent category fields, and a
 * re-uploaded workbook must resolve to the same real-world payment identity.
 */
export type FinanceSourceIdentityInput = {
  normalizedCustomerName: string;
  occurredOn: string;
  amountUsd: string;
  normalizedPaymentMethod: string;
};

/**
 * A single space -- this MUST stay byte-identical to the separator used by the
 * SQL sites that write the same `source_identity` into
 * `b2c_finance_record_lineages`: the manual bank-transfer lineage reservation
 * trigger and the manual-transfer duplicate RPC. A mismatch here is invisible
 * to the TypeScript test suite (which only ever compares TS to TS) and
 * silently breaks cross-boundary duplicate detection, so
 * tests/b2c-finance-source-identity.test.ts asserts both formulas agree.
 */
const FIELD_SEPARATOR = " ";

/**
 * Mirrors public.b2c_canonical_identity_text(text). The two are asserted
 * byte-identical over a shared corpus by
 * tests/b2c-finance-identity-parity.test.ts.
 */
export function canonicalIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

/** Canonicalizes a decimal string to exactly six fractional places so equivalent amounts hash identically. */
function canonicalIdentityAmount(value: string): string {
  const [whole, fraction = ""] = value.trim().split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.padEnd(6, "0").slice(0, 6);
  return `${normalizedWhole}.${normalizedFraction}`;
}

/**
 * Produces a stable, deterministic identity for one real-world Payment
 * Tracker payment. The same payment must hash identically across different
 * workbook uploads (different file hashes) and across the `B2C`/`B2C Cons`
 * tabs, so a replacement workbook never reposts a payment that already exists.
 */
export function createFinanceSourceIdentity(input: FinanceSourceIdentityInput): string {
  const canonical = [
    canonicalIdentityText(input.normalizedCustomerName),
    input.occurredOn.trim(),
    canonicalIdentityAmount(input.amountUsd),
    canonicalIdentityText(input.normalizedPaymentMethod),
  ].join(FIELD_SEPARATOR);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
