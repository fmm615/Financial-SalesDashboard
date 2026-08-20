import { describe, expect, it, vi } from "vitest";
import {
  linkB2cProviderEvidenceExactMatches,
  reconcileProviderEvidence,
  type LocalProviderPaymentRecord,
  type ProviderEvidenceRecord,
} from "@/server/services/b2c-provider-evidence-reconciliation";

const evidence = (overrides: Partial<ProviderEvidenceRecord> = {}): ProviderEvidenceRecord => ({
  evidenceId: "evidence-1",
  providerTransactionId: "ch_123",
  amount: "50.42",
  currency: "USD",
  occurredOn: "2026-08-09",
  ...overrides,
});

const payment = (overrides: Partial<LocalProviderPaymentRecord> = {}): LocalProviderPaymentRecord => ({
  paymentId: "payment-1",
  providerTransactionId: "ch_123",
  originalAmount: "50.42",
  originalCurrency: "USD",
  occurredOn: "2026-08-09",
  paymentStatus: "succeeded",
  ...overrides,
});

describe("reconcileProviderEvidence", () => {
  it("links an evidence row to its local payment only when transaction ID, amount, currency, date, and status all agree", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence()], payments: [payment()] });
    expect(result).toEqual({ exactMatches: [{ evidenceId: "evidence-1", paymentId: "payment-1" }], mismatches: [], unmatchedEvidence: [] });
  });

  it("tolerates decimal padding differences in an otherwise exact amount match", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence({ amount: "50.420000" })], payments: [payment({ originalAmount: "50.42" })] });
    expect(result.exactMatches).toHaveLength(1);
  });

  it("is idempotent -- repeated evidence produces the same exact match every time", () => {
    const input = { evidence: [evidence(), evidence()], payments: [payment()] };
    expect(reconcileProviderEvidence(input)).toEqual(reconcileProviderEvidence(input));
  });

  it("flags an amount mismatch on a matching transaction ID instead of auto-linking it", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence({ amount: "60.00" })], payments: [payment()] });
    expect(result.exactMatches).toHaveLength(0);
    expect(result.mismatches).toEqual([{ evidenceId: "evidence-1", paymentId: "payment-1", fields: ["amount"] }]);
  });

  it("flags a currency mismatch on a matching transaction ID", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence({ currency: "BHD" })], payments: [payment()] });
    expect(result.mismatches).toEqual([{ evidenceId: "evidence-1", paymentId: "payment-1", fields: ["currency"] }]);
  });

  it("flags a date mismatch on a matching transaction ID", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence({ occurredOn: "2026-08-10" })], payments: [payment()] });
    expect(result.mismatches).toEqual([{ evidenceId: "evidence-1", paymentId: "payment-1", fields: ["date"] }]);
  });

  it("flags a status mismatch when the local payment is not succeeded", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence()], payments: [payment({ paymentStatus: "pending" })] });
    expect(result.mismatches).toEqual([{ evidenceId: "evidence-1", paymentId: "payment-1", fields: ["status"] }]);
  });

  it("reports every mismatched field together, not just the first", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence({ amount: "1.00", currency: "BHD" })], payments: [payment()] });
    expect(result.mismatches[0].fields).toEqual(expect.arrayContaining(["amount", "currency"]));
  });

  it("retains evidence with no local API payment as unmatched, never auto-linking by name or amount", () => {
    const result = reconcileProviderEvidence({ evidence: [evidence({ providerTransactionId: "ch_no_local" })], payments: [payment()] });
    expect(result.unmatchedEvidence).toEqual(["evidence-1"]);
    expect(result.exactMatches).toHaveLength(0);
  });

  it("never links two evidence rows to the same local payment through amount/date guessing when IDs differ", () => {
    const result = reconcileProviderEvidence({
      evidence: [evidence({ evidenceId: "e1", providerTransactionId: "ch_a" }), evidence({ evidenceId: "e2", providerTransactionId: "ch_b" })],
      payments: [payment({ paymentId: "payment-1", providerTransactionId: "ch_a" })],
    });
    expect(result.exactMatches).toEqual([{ evidenceId: "e1", paymentId: "payment-1" }]);
    expect(result.unmatchedEvidence).toEqual(["e2"]);
  });
});

describe("linkB2cProviderEvidenceExactMatches", () => {
  it("persists only the exact matches, never mismatches or unmatched evidence", async () => {
    const evidenceRows = [
      { id: "e1", provider_payment_id: "ch_a", credit_amount: "50.42", original_currency: "USD", occurred_at: "2026-08-09T09:37:33.000Z" },
      { id: "e2", provider_payment_id: "ch_mismatch", credit_amount: "10.00", original_currency: "USD", occurred_at: "2026-08-09T09:37:33.000Z" },
      { id: "e3", provider_payment_id: "ch_unmatched", credit_amount: "5.00", original_currency: "USD", occurred_at: "2026-08-09T09:37:33.000Z" },
    ];
    const paymentRows = [
      { id: "p1", provider_transaction_id: "ch_a", original_amount: "50.42", original_currency: "USD", occurred_on: "2026-08-09", payment_status: "succeeded" },
      { id: "p2", provider_transaction_id: "ch_mismatch", original_amount: "99.00", original_currency: "USD", occurred_on: "2026-08-09", payment_status: "succeeded" },
    ];

    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_provider_evidence") {
          const builder: Record<string, unknown> = {};
          builder.select = vi.fn().mockReturnValue(builder);
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: evidenceRows, error: null });
          return builder;
        }
        if (table === "b2c_payments") {
          const builder: Record<string, unknown> = {};
          builder.select = vi.fn().mockReturnValue(builder);
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.in = vi.fn().mockReturnValue(builder);
          builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: paymentRows, error: null });
          return builder;
        }
        if (table === "b2c_provider_evidence_payment_links") return { upsert };
        throw new Error(`Unexpected table ${table}`);
      }),
    };

    const result = await linkB2cProviderEvidenceExactMatches(client as never, { importId: "import-1", provider: "stripe" });

    expect(result.exactMatches).toEqual([{ evidenceId: "e1", paymentId: "p1" }]);
    expect(result.mismatches).toHaveLength(1);
    expect(result.unmatchedEvidence).toEqual(["e3"]);
    expect(upsert).toHaveBeenCalledWith(
      [{ provider_evidence_id: "e1", payment_id: "p1", match_state: "exact_match", matched_during_import_id: "import-1" }],
      { onConflict: "provider_evidence_id", ignoreDuplicates: true },
    );
  });

  it("is idempotent -- repeated evidence links upsert-ignore rather than duplicate", async () => {
    const evidenceRows = [{ id: "e1", provider_payment_id: "ch_a", credit_amount: "50.42", original_currency: "USD", occurred_at: "2026-08-09T09:37:33.000Z" }];
    const paymentRows = [{ id: "p1", provider_transaction_id: "ch_a", original_amount: "50.42", original_currency: "USD", occurred_on: "2026-08-09", payment_status: "succeeded" }];
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_provider_evidence") {
          const builder: Record<string, unknown> = {};
          builder.select = vi.fn().mockReturnValue(builder);
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: evidenceRows, error: null });
          return builder;
        }
        if (table === "b2c_payments") {
          const builder: Record<string, unknown> = {};
          builder.select = vi.fn().mockReturnValue(builder);
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.in = vi.fn().mockReturnValue(builder);
          builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: paymentRows, error: null });
          return builder;
        }
        if (table === "b2c_provider_evidence_payment_links") return { upsert };
        throw new Error(`Unexpected table ${table}`);
      }),
    };

    await linkB2cProviderEvidenceExactMatches(client as never, { importId: "import-1", provider: "tap" });
    await linkB2cProviderEvidenceExactMatches(client as never, { importId: "import-2", provider: "tap" });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: "provider_evidence_id", ignoreDuplicates: true });
  });

  it("never links evidence to a payment, and never inserts links, when the import has no sale evidence", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_provider_evidence") {
          const builder: Record<string, unknown> = {};
          builder.select = vi.fn().mockReturnValue(builder);
          builder.eq = vi.fn().mockReturnValue(builder);
          builder.then = (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: [], error: null });
          return builder;
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };

    const result = await linkB2cProviderEvidenceExactMatches(client as never, { importId: "import-1", provider: "stripe" });
    expect(result).toEqual({ exactMatches: [], mismatches: [], unmatchedEvidence: [] });
  });
});
