import { describe, expect, it, vi } from "vitest";
import { SupabaseStripeSyncRepository, SupabaseTapSyncRepository, type B2cProvider, type NormalisedB2cProviderCharge } from "@/server/repositories/stripe-sync-repository";

type PaymentWrite = Record<string, unknown>;

function createProviderClient(input: { existingPayment?: Record<string, unknown> | null } = {}) {
  const tableNames: string[] = [];
  const selections: Array<{ table: string; columns: string }> = [];
  const paymentInserts: PaymentWrite[] = [];
  const paymentUpdates: PaymentWrite[] = [];
  const reviewFlagInserts: PaymentWrite[] = [];

  function queryFor(table: string) {
    const query = {
      select: vi.fn((columns: string) => {
        selections.push({ table, columns });
        return query;
      }),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        if (table === "b2c_payments") return { data: input.existingPayment ?? null, error: null };
        return { data: null, error: null };
      }),
      insert: vi.fn((values: PaymentWrite) => {
        if (table === "customers") return query;
        if (table === "b2c_payments") paymentInserts.push(values);
        return query;
      }),
      update: vi.fn((values: PaymentWrite) => {
        if (table === "b2c_payments") paymentUpdates.push(values);
        return query;
      }),
      upsert: vi.fn((values: PaymentWrite) => {
        if (table === "review_flags") reviewFlagInserts.push(values);
        return query;
      }),
      single: vi.fn(async () => {
        if (table === "customers") return { data: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, error: null };
        if (table === "b2c_payments") return { data: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, error: null };
        return { data: null, error: null };
      }),
    };
    return query;
  }

  return {
    client: {
      from: vi.fn((table: string) => {
        tableNames.push(table);
        return queryFor(table);
      }),
    } as never,
    tableNames,
    selections,
    paymentInserts,
    paymentUpdates,
    reviewFlagInserts,
  };
}

function providerCharge(provider: B2cProvider): NormalisedB2cProviderCharge {
  return {
    chargeId: `${provider}_charge_123`,
    customerEmail: "member@example.com",
    customerName: "Member Name",
    customerPhone: "+97317000000",
    productReference: `${provider}_price_founding`,
    paymentStatus: "succeeded",
    originalAmount: "120.000000",
    originalCurrency: "USD",
    exchangeRateToUsd: "1.0000000000",
    amountUsd: "120.000000",
    occurredAt: "2026-08-24T09:00:00.000Z",
    occurredOn: "2026-08-24",
    sourceMetadata: {
      description: `${provider} founding membership`,
      provider_plan_name: "Founding Membership",
      customer_email_source: "charge_receipt",
    },
  };
}

describe("B2C provider payment persistence", () => {
  it.each([
    ["Stripe", SupabaseStripeSyncRepository, "stripe"],
    ["Tap", SupabaseTapSyncRepository, "tap"],
  ] as const)("persists a new %s charge with no product mapping or category concept", async (_label, Repository, provider) => {
    const fake = createProviderClient();

    await new Repository(fake.client).persistCharge(providerCharge(provider));

    expect(fake.tableNames).not.toContain("product_mappings");
    expect(fake.paymentInserts).toEqual([
      expect.objectContaining({
        membership_tier: "Founding Membership",
        source_metadata: expect.objectContaining({
          description: `${provider} founding membership`,
          provider_plan_name: "Founding Membership",
        }),
      }),
    ]);
    expect(fake.reviewFlagInserts.map((flag) => flag.flag_type)).not.toContain("unmapped_product");
  });

  it("preserves a provider payment plan or tier on redelivery", async () => {
    const fake = createProviderClient({
      existingPayment: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        provider_event_id: "evt_original",
        customer_email: "member@example.com",
        customer_name: "Member Name",
        customer_phone: "+97317000000",
        membership_tier: "annual",
        source_metadata: { customer_email_source: "charge_receipt" },
      },
    });

    await new SupabaseStripeSyncRepository(fake.client).persistCharge(providerCharge("stripe"));

    expect(fake.selections).toContainEqual(expect.objectContaining({
      table: "b2c_payments",
      columns: expect.stringContaining("customer_phone,membership_tier"),
    }));
    expect(fake.paymentUpdates).toEqual([
      expect.objectContaining({ membership_tier: "annual" }),
    ]);
    // The retired mapping table and the removed category are never touched.
    expect(fake.paymentUpdates[0]).not.toHaveProperty("product_mapping_id");
    expect(fake.paymentUpdates[0]).not.toHaveProperty("category_code");
  });
});
