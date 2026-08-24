import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalIdentityText } from "@/lib/b2c/finance-source-identity";
import { identityParityCorpus } from "./b2c-identity-parity-corpus";

/**
 * `sql-canonical-identity.json` is generated FROM the database by
 * `npm run supabase:test` (see the pgTAP fixture in
 * supabase/tests/database_foundation.test.sql). Regenerate it whenever the
 * corpus or the SQL function changes -- never hand-edit it.
 */
const sqlOutput = JSON.parse(
  readFileSync("tests/fixtures/sql-canonical-identity.json", "utf8"),
) as Record<string, string>;

describe("identity canonicalization is identical in TypeScript and SQL", () => {
  it("covers every corpus entry", () => {
    for (const name of identityParityCorpus) {
      expect(Object.keys(sqlOutput)).toContain(name);
    }
  });

  for (const name of identityParityCorpus) {
    it(`agrees for ${JSON.stringify(name)}`, () => {
      expect(canonicalIdentityText(name)).toBe(sqlOutput[name]);
    });
  }
});
