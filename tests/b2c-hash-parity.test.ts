import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createB2cDuplicateFingerprint } from "@/lib/b2c/duplicate-fingerprint";
import { hashPreparedManualBankTransfer } from "@/server/services/record-manual-bank-transfer";
import { b2cHashParityCorpus } from "./b2c-hash-parity-corpus";

type SqlHashFixture = Record<string, {
  duplicateFingerprint: string;
  reviewedInputHash: string;
}>;

/**
 * Generated from the local PostgreSQL digest expressions exercised by the
 * pgTAP manual-transfer calls. Never hand-edit this fixture: regenerate it
 * from the database whenever either cross-language hash contract changes.
 */
const sqlOutput = JSON.parse(
  readFileSync("tests/fixtures/sql-b2c-hashes.json", "utf8"),
) as SqlHashFixture;

describe("manual-transfer hashes agree between TypeScript and PostgreSQL", () => {
  for (const entry of b2cHashParityCorpus) {
    it(`covers the SQL fixture for ${entry.key}`, () => {
      expect(sqlOutput[entry.key]).toBeDefined();
    });

    it(`matches the SQL content fingerprint for ${entry.key}`, () => {
      expect(createB2cDuplicateFingerprint(entry.duplicateFingerprint)).toBe(
        sqlOutput[entry.key]?.duplicateFingerprint,
      );
    });

    it(`matches the SQL reviewed-input hash for ${entry.key}`, () => {
      expect(hashPreparedManualBankTransfer(entry.reviewedInput)).toBe(
        sqlOutput[entry.key]?.reviewedInputHash,
      );
    });
  }
});
