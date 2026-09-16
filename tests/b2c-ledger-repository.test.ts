import { describe, expect, it, vi } from "vitest";
import {
  B2cLedgerCursorError,
  SupabaseB2cLedgerRepository,
  decorateB2cLedgerRow,
  decodeB2cLedgerCursor,
  encodeB2cLedgerCursor,
} from "@/server/repositories/b2c-ledger-repository";
import { buildB2cLedgerEquivalenceFixture } from "./fixtures/b2c-ledger-equivalence";

const reportableDecision = {
  source_status: "succeeded",
  reconciliation_status: "not_required",
  reporting_decision: "reportable",
  posting_status: "not_applicable",
  exclusion_reasons: [],
  blocking_reasons: [],
};

function rawPayment(id: string, name: string) {
  return {
    id,
    record_type: "Payment",
    customer_name: name,
    customer_email: `${name.toLowerCase()}@example.com`,
    customer_phone: null,
    customer_name_evidence_label: null,
    customer_email_evidence_label: null,
    customer_phone_evidence_label: null,
    date_value: "2026-08-20",
    amount_value_usd: "13.000000",
    source_original_amount: "13.000000",
    source_original_currency: "USD",
    source_description: null,
    source_seller_message: null,
    foreign_currency_review: false,
    has_fx_conversion: false,
    fx_conversion_source: null,
    fx_conversion_effective_on: null,
    source_date_value: "2026-08-20",
    membership_tier: null,
    source: "Stripe",
    payment_status: "Completed",
    provider_reference: `ch_${id}`,
    source_system: "stripe",
    product_reference: null,
    source_metadata: {},
    has_local_correction: false,
    local_correction_fields: [],
    has_finance_exception: false,
    has_open_payment_duplicate: false,
    has_duplicate_exclusion: false,
    open_review_flags: [],
    issue: null,
  };
}

describe("B2C ledger keyset cursor", () => {
  it("round-trips the exact sort boundary", () => {
    const cursor = {
      version: 1 as const,
      sort: "amount_desc" as const,
      value: "13.000000",
      recordType: "Payment" as const,
      id: "11111111-1111-4111-8111-111111111111",
    };
    expect(decodeB2cLedgerCursor(encodeB2cLedgerCursor(cursor), "amount_desc")).toEqual(cursor);
  });

  it("rejects malformed and wrong-sort cursors instead of broadening to page one", () => {
    expect(() => decodeB2cLedgerCursor("not-a-cursor", "date_desc")).toThrow(B2cLedgerCursorError);
    const amountCursor = encodeB2cLedgerCursor({
      version: 1, sort: "amount_asc", value: "13", recordType: "Payment",
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(() => decodeB2cLedgerCursor(amountCursor, "date_desc")).toThrow(/sort/i);
  });
});

describe("B2C ledger equivalence fixture", () => {
  it("covers a realistically large history and every financially sensitive edge case", () => {
    const fixture = buildB2cLedgerEquivalenceFixture(1_250);

    expect(fixture.payments).toHaveLength(1_250);
    expect(fixture.refunds.length).toBeGreaterThan(100);
    expect(fixture.namedCases).toEqual({
      movedIn: "70000000-0000-4000-8000-000000000001",
      movedOut: "70000000-0000-4000-8000-000000000002",
      foreignConverted: "70000000-0000-4000-8000-000000000003",
      foreignMissingFx: "70000000-0000-4000-8000-000000000004",
      openFlag: "70000000-0000-4000-8000-000000000005",
      duplicateExcluded: "70000000-0000-4000-8000-000000000006",
      financeException: "70000000-0000-4000-8000-000000000007",
    });
    expect(fixture.localOverrides).toHaveLength(2);
    expect(fixture.paymentFxConversions).toHaveLength(1);
    expect(fixture.reviewFlags.some((flag) => flag.source_record_id === fixture.namedCases.openFlag)).toBe(true);
  });
});

describe("SupabaseB2cLedgerRepository", () => {
  it("requests limit plus one identities and hydrates only the returned page IDs", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_b2c_ledger_page") {
        return { data: ids.map((id) => ({ record_type: "Payment", record_id: id, sort_value: "2026-08-20", decision: reportableDecision })), error: null };
      }
      if (name === "get_b2c_ledger_metadata") {
        return { data: { total_count: 3, sources: ["Stripe"], issues: [], foreign_currency_count: 0 }, error: null };
      }
      if (name === "get_b2c_ledger_rows") {
        expect(args).toMatchObject({ p_payment_ids: ids.slice(0, 2), p_refund_ids: [] });
        return {
          data: [
            { record_type: "Payment", record_id: ids[1], row_data: rawPayment(ids[1], "Second"), decision: reportableDecision },
            { record_type: "Payment", record_id: ids[0], row_data: rawPayment(ids[0], "First"), decision: reportableDecision },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const repository = new SupabaseB2cLedgerRepository({ rpc } as never);

    const page = await repository.page({ period: "2026-08", limit: 2 }, new Date("2026-08-31T00:00:00.000Z"));

    expect(rpc).toHaveBeenCalledWith("get_b2c_ledger_page", expect.objectContaining({ p_limit: 3, p_period: "2026-08" }));
    expect(page.rows.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(page.rows[0].decision.reportingDecision).toBe("reportable");
    expect(page.rows[0].amountUsd).toBe("$13.00");
    expect(page.hasMore).toBe(true);
    expect(page.totalCount).toBe(3);
    expect(decodeB2cLedgerCursor(page.nextCursor!, "date_desc")).toMatchObject({
      value: "2026-08-20", recordType: "Payment", id: ids[1],
    });
  });

  it("returns an empty bounded page without issuing a hydration RPC", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "get_b2c_ledger_page") return { data: [], error: null };
      if (name === "get_b2c_ledger_metadata") {
        return { data: { total_count: 0, sources: [], issues: [], foreign_currency_count: 0 }, error: null };
      }
      throw new Error("Hydration should not run for an empty page.");
    });
    const repository = new SupabaseB2cLedgerRepository({ rpc } as never);

    await expect(repository.page({ period: "2026-08" }, new Date("2026-08-31T00:00:00.000Z"))).resolves.toMatchObject({
      rows: [], hasMore: false, nextCursor: null, totalCount: 0,
    });
    expect(rpc).not.toHaveBeenCalledWith("get_b2c_ledger_rows", expect.anything());
  });

  it("preserves the legacy compact display for a foreign source amount", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const foreign = {
      ...rawPayment(id, "Foreign"),
      amount_value_usd: null,
      source_original_amount: "23.000000",
      source_original_currency: "BHD",
      foreign_currency_review: true,
    };
    const rpc = vi.fn(async (name: string) => {
      if (name === "get_b2c_ledger_page") return { data: [{ record_type: "Payment", record_id: id, sort_value: "2026-08-20", decision: reportableDecision }], error: null };
      if (name === "get_b2c_ledger_metadata") return { data: { total_count: 1, sources: ["Stripe"], issues: [], foreign_currency_count: 1 }, error: null };
      if (name === "get_b2c_ledger_rows") return { data: [{ record_type: "Payment", record_id: id, row_data: foreign, decision: reportableDecision }], error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });

    const page = await new SupabaseB2cLedgerRepository({ rpc } as never).page({ period: "all" });

    expect(page.rows[0].sourceAmountUsd).toBe("23 BHD");
    expect(page.rows[0].amountUsd).toBe("23 BHD");
  });

  it("loads every matching export page with the same filters and no client-visible pagination", async () => {
    const repository = new SupabaseB2cLedgerRepository({} as never);
    const firstRows = Array.from({ length: 100 }, (_, index) => ({ id: `first-${index}` }));
    const finalRows = Array.from({ length: 25 }, (_, index) => ({ id: `final-${index}` }));
    const page = vi.spyOn(repository, "page")
      .mockResolvedValueOnce({ rows: firstRows, nextCursor: "next-page", hasMore: true, totalCount: 125, filterMetadata: { sources: [], issues: [], foreignCurrencyCount: 0 } } as never)
      .mockResolvedValueOnce({ rows: finalRows, nextCursor: null, hasMore: false, totalCount: 125, filterMetadata: { sources: [], issues: [], foreignCurrencyCount: 0 } } as never);

    const result = await repository.exportRows({ period: "2026-08", source: "stripe", search: "Maya" }, new Date("2026-08-31T00:00:00.000Z"));

    expect(result).toMatchObject({ capped: false, totalCount: 125 });
    expect(result.rows).toHaveLength(125);
    expect(page).toHaveBeenNthCalledWith(1, { period: "2026-08", source: "stripe", search: "Maya", cursor: undefined, limit: 100 }, expect.any(Date));
    expect(page).toHaveBeenNthCalledWith(2, { period: "2026-08", source: "stripe", search: "Maya", cursor: "next-page", limit: 100 }, expect.any(Date));
  });

  it("reports when an export stops at the fixed 5,000-row cap", async () => {
    const repository = new SupabaseB2cLedgerRepository({} as never);
    vi.spyOn(repository, "page").mockResolvedValue({
      rows: Array.from({ length: 5_000 }, (_, index) => ({ id: `row-${index}` })),
      nextCursor: "more-rows",
      hasMore: true,
      totalCount: 5_001,
      filterMetadata: { sources: [], issues: [], foreignCurrencyCount: 0 },
    } as never);

    const result = await repository.exportRows({ period: "all" });

    expect(result).toMatchObject({ capped: true, totalCount: 5_001 });
    expect(result.rows).toHaveLength(5_000);
  });
});

describe("decorateB2cLedgerRow", () => {
  it("presents the SQL-produced decision attached by the Work snapshot", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      recordType: "Payment",
      customerName: "Clean-looking payment",
      customerEmail: "clean@example.com",
      sqlDecision: {
        source_status: "succeeded",
        reconciliation_status: "duplicate_pending",
        reporting_decision: "blocked",
        posting_status: "not_applicable",
        exclusion_reasons: ["possible_duplicate"],
        blocking_reasons: ["possible_duplicate"],
      },
    } as never;

    expect(decorateB2cLedgerRow(row).decision).toMatchObject({
      reportingDecision: "blocked",
      blockingReasons: ["possible_duplicate"],
    });
  });
});
