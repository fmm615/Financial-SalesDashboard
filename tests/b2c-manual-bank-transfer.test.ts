import { describe, expect, it, vi } from "vitest";
import { manualBankTransferSchema } from "@/lib/validation/financial-contracts";
import {
  hashPreparedManualBankTransfer,
  prepareManualBankTransfer,
  previewManualBankTransfer,
  recordManualBankTransfer,
  type ManualBankTransferDuplicateAssessment,
  type ManualBankTransferRequest,
} from "@/server/services/record-manual-bank-transfer";
import { SupabaseB2cPaymentsRepository, type B2cPaymentsRepository } from "@/server/repositories/b2c-payments-repository";

const baseInput: ManualBankTransferRequest = {
  bankReference: "IBAN-2026-0912",
  customerEmail: "MEMBER@Playbook.test",
  customerName: "Ada Founder",
  categoryCode: "membership",
  amountUsd: "266",
  receivedAt: "2026-08-12T08:00:00+03:00",
  reason: "New bank transfer received after the latest workbook.",
};

const clearAssessment: ManualBankTransferDuplicateAssessment = {
  inputSha256: "0".repeat(64),
  matchState: "clear",
  exactMatchReason: null,
  exactMatchHref: null,
  possibleMatches: [],
};

function mockRepository(): { [K in keyof B2cPaymentsRepository]: ReturnType<typeof vi.fn> } {
  return {
    assessManualBankTransferDuplicates: vi.fn(),
    createManualBankTransferAtomically: vi.fn(),
  };
}

describe("prepareManualBankTransfer", () => {
  it("derives the Asia/Bahrain business date from the bank's own transfer timestamp, never a bare date", () => {
    // 2026-08-12T22:30:00+00:00 is already 2026-08-13 in Asia/Bahrain (UTC+3).
    const prepared = prepareManualBankTransfer({ ...baseInput, receivedAt: "2026-08-12T22:30:00.000Z" });
    expect(prepared.occurredOn).toBe("2026-08-13");
  });

  it("canonicalizes the amount to six decimal places and normalizes email/name whitespace", () => {
    const prepared = prepareManualBankTransfer({ ...baseInput, amountUsd: "266", customerEmail: "  MEMBER@Playbook.test  ", customerName: "  Ada Founder  " });
    expect(prepared.amountUsd).toBe("266.000000");
    expect(prepared.customerEmail).toBe("member@playbook.test");
    expect(prepared.customerName).toBe("Ada Founder");
  });

  it("keeps membershipTier null rather than an empty string when omitted", () => {
    expect(prepareManualBankTransfer(baseInput).membershipTier).toBeNull();
  });
});

describe("hashPreparedManualBankTransfer", () => {
  it("is deterministic for the same prepared input and changes when any field changes", () => {
    const prepared = prepareManualBankTransfer(baseInput);
    expect(hashPreparedManualBankTransfer(prepared)).toBe(hashPreparedManualBankTransfer(prepared));
    const changed = prepareManualBankTransfer({ ...baseInput, amountUsd: "267" });
    expect(hashPreparedManualBankTransfer(prepared)).not.toBe(hashPreparedManualBankTransfer(changed));
  });
});

describe("manualBankTransferSchema", () => {
  it("requires bankReference, customerName, and customerEmail", () => {
    expect(manualBankTransferSchema.safeParse({ ...baseInput, bankReference: "" }).success).toBe(false);
    expect(manualBankTransferSchema.safeParse({ ...baseInput, customerName: "" }).success).toBe(false);
    expect(manualBankTransferSchema.safeParse({ ...baseInput, customerEmail: "not-an-email" }).success).toBe(false);
  });

  it("requires an explicit UTC offset on receivedAt", () => {
    expect(manualBankTransferSchema.safeParse({ ...baseInput, receivedAt: "2026-08-12T08:00:00" }).success).toBe(false);
  });

  it("accepts a clean request with an optional membership tier", () => {
    expect(manualBankTransferSchema.safeParse({ ...baseInput, membershipTier: "gold" }).success).toBe(true);
  });
});

describe("previewManualBankTransfer", () => {
  it("delegates straight to the repository's read-only assessment", async () => {
    const repository = mockRepository();
    repository.assessManualBankTransferDuplicates.mockResolvedValue(clearAssessment);

    await expect(previewManualBankTransfer(baseInput, repository)).resolves.toBe(clearAssessment);
    expect(repository.createManualBankTransferAtomically).not.toHaveBeenCalled();
  });
});

describe("recordManualBankTransfer", () => {
  it("rejects a reused bank reference", async () => {
    const repository = mockRepository();
    repository.assessManualBankTransferDuplicates.mockResolvedValue({
      inputSha256: hashPreparedManualBankTransfer(prepareManualBankTransfer(baseInput)),
      matchState: "exact_existing", exactMatchReason: "bank_reference", exactMatchHref: "/operations/b2c?tab=work&record=existing-payment", possibleMatches: [],
    } satisfies ManualBankTransferDuplicateAssessment);

    const input = { ...baseInput, expectedInputSha256: hashPreparedManualBankTransfer(prepareManualBankTransfer(baseInput)) };
    await expect(recordManualBankTransfer(input, repository)).rejects.toThrow("already exists");
    expect(repository.createManualBankTransferAtomically).not.toHaveBeenCalled();
  });

  it("rejects a new manual row that is already an unposted tracker lineage", async () => {
    const repository = mockRepository();
    repository.assessManualBankTransferDuplicates.mockResolvedValue({
      inputSha256: hashPreparedManualBankTransfer(prepareManualBankTransfer(baseInput)),
      matchState: "exact_existing", exactMatchReason: "finance_lineage", exactMatchHref: "/operations/b2c?tab=work&queue=reconciliation", possibleMatches: [],
    } satisfies ManualBankTransferDuplicateAssessment);

    const input = { ...baseInput, expectedInputSha256: hashPreparedManualBankTransfer(prepareManualBankTransfer(baseInput)) };
    await expect(recordManualBankTransfer(input, repository)).rejects.toThrow("Payment Tracker");
    expect(repository.createManualBankTransferAtomically).not.toHaveBeenCalled();
  });

  it("rejects a new manual row that already matches a posted tracker lineage", async () => {
    const repository = mockRepository();
    repository.assessManualBankTransferDuplicates.mockResolvedValue({
      inputSha256: hashPreparedManualBankTransfer(prepareManualBankTransfer(baseInput)),
      matchState: "exact_existing", exactMatchReason: "finance_lineage", exactMatchHref: "/operations/b2c?tab=work&record=posted-payment", possibleMatches: [],
    } satisfies ManualBankTransferDuplicateAssessment);

    const input = { ...baseInput, expectedInputSha256: hashPreparedManualBankTransfer(prepareManualBankTransfer(baseInput)) };
    await expect(recordManualBankTransfer(input, repository)).rejects.toThrow("Payment Tracker");
  });

  it("rejects stale review input that changed since preview without even rerunning the duplicate assessment", async () => {
    const repository = mockRepository();
    const input = { ...baseInput, expectedInputSha256: "f".repeat(64) };

    await expect(recordManualBankTransfer(input, repository)).rejects.toThrow(/changed since preview/i);
    expect(repository.assessManualBankTransferDuplicates).not.toHaveBeenCalled();
    expect(repository.createManualBankTransferAtomically).not.toHaveBeenCalled();
  });

  it("retains a possible (non-exact) 48-hour content match rather than rejecting it", async () => {
    const repository = mockRepository();
    const prepared = prepareManualBankTransfer(baseInput);
    const inputSha256 = hashPreparedManualBankTransfer(prepared);
    repository.assessManualBankTransferDuplicates.mockResolvedValue({
      inputSha256, matchState: "possible_duplicate", exactMatchReason: null, exactMatchHref: null,
      possibleMatches: [{ recordKind: "provider_payment", recordId: "stripe-payment-1", sourceLabel: "Stripe", occurredOn: "2026-08-12", amountUsd: "266.000000" }],
    } satisfies ManualBankTransferDuplicateAssessment);
    const createdPayment = { id: "new-payment-1" } as never;
    repository.createManualBankTransferAtomically.mockResolvedValue(createdPayment);

    const input = { ...baseInput, expectedInputSha256: inputSha256 };
    await expect(recordManualBankTransfer(input, repository)).resolves.toBe(createdPayment);
    expect(repository.createManualBankTransferAtomically).toHaveBeenCalledWith(expect.objectContaining({ ...prepared, expectedInputSha256: inputSha256 }));
  });

  it("creates one reportable payment for a genuinely new, clean transfer", async () => {
    const repository = mockRepository();
    const prepared = prepareManualBankTransfer(baseInput);
    const inputSha256 = hashPreparedManualBankTransfer(prepared);
    repository.assessManualBankTransferDuplicates.mockResolvedValue({ ...clearAssessment, inputSha256 });
    const createdPayment = { id: "new-payment-2" } as never;
    repository.createManualBankTransferAtomically.mockResolvedValue(createdPayment);

    const input = { ...baseInput, expectedInputSha256: inputSha256 };
    await expect(recordManualBankTransfer(input, repository)).resolves.toBe(createdPayment);
    expect(repository.createManualBankTransferAtomically).toHaveBeenCalledWith(expect.objectContaining({ reason: prepared.reason, bankReference: prepared.bankReference }));
  });
});

function chainable(resolveWith: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.in = vi.fn().mockReturnValue(builder);
  builder.gte = vi.fn().mockReturnValue(builder);
  builder.lte = vi.fn().mockReturnValue(builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(resolveWith);
  builder.then = (resolve: (value: unknown) => unknown) => resolve(resolveWith);
  return builder;
}

describe("SupabaseB2cPaymentsRepository.assessManualBankTransferDuplicates", () => {
  it("returns an exact bank-reference match with a link to the existing payment", async () => {
    const client = { from: vi.fn().mockReturnValue(chainable({ data: { id: "existing-payment" }, error: null })) };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("exact_existing");
    expect(result.exactMatchReason).toBe("bank_reference");
    expect(result.exactMatchHref).toBe("/operations/b2c?tab=work&record=existing-payment");
  });

  it("returns an exact Finance-lineage match already represented by an existing manual payment", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") return chainable({ data: null, error: null });
        if (table === "b2c_finance_record_lineages") return chainable({ data: { id: "lineage-1", represented_payment_id: "manual-payment-1" }, error: null });
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("exact_existing");
    expect(result.exactMatchReason).toBe("finance_lineage");
    expect(result.exactMatchHref).toBe("/operations/b2c?tab=work&record=manual-payment-1");
  });

  it("returns an exact Finance-lineage match against a posted tracker lineage, linking to the posted payment", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") return chainable({ data: null, error: null });
        if (table === "b2c_finance_record_lineages") return chainable({ data: { id: "lineage-2", represented_payment_id: null }, error: null });
        if (table === "b2c_finance_ledger_posts") return chainable({ data: { payment_id: "posted-payment-1" }, error: null });
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("exact_existing");
    expect(result.exactMatchHref).toBe("/operations/b2c?tab=work&record=posted-payment-1");
  });

  it("returns an exact Finance-lineage match against an unposted tracker lineage with a generic reconciliation link", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") return chainable({ data: null, error: null });
        if (table === "b2c_finance_record_lineages") return chainable({ data: { id: "lineage-3", represented_payment_id: null }, error: null });
        if (table === "b2c_finance_ledger_posts") return chainable({ data: null, error: null });
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("exact_existing");
    expect(result.exactMatchHref).toBe("/operations/b2c?tab=work&queue=reconciliation");
  });

  it("rejects when an unresolved import-version candidate shares the identity, without a decision", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") return chainable({ data: null, error: null });
        if (table === "b2c_finance_record_lineages") return chainable({ data: null, error: null });
        if (table === "b2c_finance_import_version_candidates") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [{ id: "candidate-1" }], error: null }) };
        if (table === "b2c_finance_import_version_decisions") return { select: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: [], error: null }) };
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("exact_existing");
    expect(result.exactMatchHref).toBe("/operations/b2c?tab=work&queue=reconciliation");
  });

  it("falls through to the standard content check once every matching candidate already has a decision", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") return chainable({ data: null, error: null });
        if (table === "b2c_finance_record_lineages") return chainable({ data: null, error: null });
        if (table === "b2c_finance_import_version_candidates") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [{ id: "candidate-1" }], error: null }) };
        if (table === "b2c_finance_import_version_decisions") return { select: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: [{ candidate_id: "candidate-1" }], error: null }) };
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("clear");
  });

  it("retains a possible match from the standard 48-hour content check", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") {
          const builder = chainable({ data: null, error: null });
          builder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [{ id: "stripe-1", source_system: "stripe", occurred_on: "2026-08-12", amount_usd: "266.000000" }], error: null });
          return builder;
        }
        if (table === "b2c_finance_record_lineages") return chainable({ data: null, error: null });
        if (table === "b2c_finance_import_version_candidates") return chainable({ data: [], error: null });
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result.matchState).toBe("possible_duplicate");
    expect(result.possibleMatches).toEqual([{ recordKind: "provider_payment", recordId: "stripe-1", sourceLabel: "Stripe", occurredOn: "2026-08-12", amountUsd: "266.000000" }]);
  });

  it("returns a clean assessment for a genuinely new transfer", async () => {
    const client = {
      from: vi.fn((table: string) => {
        if (table === "b2c_payments") {
          const builder = chainable({ data: null, error: null });
          builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
          return builder;
        }
        if (table === "b2c_finance_record_lineages") return chainable({ data: null, error: null });
        if (table === "b2c_finance_import_version_candidates") return chainable({ data: [], error: null });
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    const result = await repository.assessManualBankTransferDuplicates(prepareManualBankTransfer(baseInput));

    expect(result).toMatchObject({ matchState: "clear", exactMatchHref: null, possibleMatches: [] });
  });
});

describe("SupabaseB2cPaymentsRepository.createManualBankTransferAtomically", () => {
  it("calls the protected RPC with the reviewed reason and returns the created payment", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "created-payment" }, error: null });
    const client = { rpc };
    const repository = new SupabaseB2cPaymentsRepository(client as never);
    const prepared = prepareManualBankTransfer(baseInput);

    const result = await repository.createManualBankTransferAtomically({ ...prepared, expectedInputSha256: "a".repeat(64) });

    expect(result).toEqual({ id: "created-payment" });
    expect(rpc).toHaveBeenCalledWith("record_b2c_manual_bank_transfer", expect.objectContaining({
      p_bank_reference: prepared.bankReference,
      p_reason: prepared.reason,
      p_expected_input_sha256: "a".repeat(64),
    }));
  });

  it("does not let two concurrent confirmations for the same reference both succeed", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { id: "winner" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "A manual bank transfer with this reference already exists" } });
    const client = { rpc };
    const repository = new SupabaseB2cPaymentsRepository(client as never);
    const prepared = prepareManualBankTransfer(baseInput);
    const write = () => repository.createManualBankTransferAtomically({ ...prepared, expectedInputSha256: "a".repeat(64) });

    const [first, second] = await Promise.allSettled([write(), write()]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
  });
});
