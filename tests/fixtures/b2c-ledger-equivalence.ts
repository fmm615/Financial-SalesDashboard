const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

function fixtureUuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fixtureDate(index: number): string {
  const date = new Date(Date.UTC(2025, 3, 1 + ((index - 1) % 540)));
  return date.toISOString().slice(0, 10);
}

function fingerprint(index: number): string {
  return index.toString(16).padStart(64, "0");
}

export type B2cLedgerEquivalenceFixture = ReturnType<typeof buildB2cLedgerEquivalenceFixture>;

/** Deterministic local-only rows used by the correctness and timing runner. */
export function buildB2cLedgerEquivalenceFixture(count: number) {
  if (!Number.isInteger(count) || count < 125) throw new Error("The B2C equivalence fixture requires at least 125 payments.");

  const namedCases = {
    movedIn: fixtureUuid("70000000", 1),
    movedOut: fixtureUuid("70000000", 2),
    foreignConverted: fixtureUuid("70000000", 3),
    foreignMissingFx: fixtureUuid("70000000", 4),
    openFlag: fixtureUuid("70000000", 5),
    duplicateExcluded: fixtureUuid("70000000", 6),
    financeException: fixtureUuid("70000000", 7),
  };

  const payments = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const id = fixtureUuid("70000000", index);
    const sourceSystem = index % 2 === 0 ? "tap" : "stripe";
    const isForeign = index % 29 === 0 || index === 3 || index === 4;
    const originalAmount = `${(index % 400) + 20}.000000`;
    const occurredOn = index === 1 ? "2026-07-31" : index === 2 ? "2026-08-01" : fixtureDate(index);
    const paymentStatus = index % 23 === 0 ? "pending" : index % 19 === 0 ? "failed" : "succeeded";
    const customerEmail = index === 7 || index % 31 === 0 ? null : `fixture-${index}@playbook.test`;
    return {
      id,
      source_system: sourceSystem,
      provider_transaction_id: `fixture-${sourceSystem}-${index}`,
      provider_event_id: `fixture-event-${index}`,
      customer_email: customerEmail,
      customer_name: `Fixture customer ${index}`,
      customer_phone: index % 9 === 0 ? "+97317000000" : null,
      membership_tier: index % 7 === 0 ? null : index % 2 === 0 ? "Annual" : "Monthly",
      payment_status: paymentStatus,
      original_amount: originalAmount,
      original_currency: isForeign ? "BHD" : "USD",
      exchange_rate_to_usd: isForeign ? null : "1.0000000000",
      amount_usd: isForeign ? null : originalAmount,
      gross_amount_usd: isForeign ? null : originalAmount,
      occurred_at: `${occurredOn}T${String(23 - Math.floor((index - 1) / 540)).padStart(2, "0")}:00:00.000Z`,
      occurred_on: occurredOn,
      duplicate_fingerprint: fingerprint(index),
      source_metadata: {
        description: `Fixture payment ${index}`,
        product_reference: `fixture-product-${index % 8}`,
      },
    };
  });

  const refunds = payments.flatMap((payment, offset) => {
    const index = offset + 1;
    if (index < 8 || index % 10 !== 0 || payment.original_currency !== "USD") return [];
    const refundIndex = Math.floor(index / 10);
    return [{
      id: fixtureUuid("71000000", refundIndex),
      payment_id: payment.id,
      source_system: payment.source_system,
      provider_refund_id: `fixture-refund-${refundIndex}`,
      original_amount: "1.000000",
      original_currency: "USD",
      exchange_rate_to_usd: "1.0000000000",
      amount_usd: "1.000000",
      reason: "Deterministic performance fixture refund.",
      occurred_at: `${payment.occurred_on}T${String(20 - Math.floor((index - 1) / 540)).padStart(2, "0")}:30:00.000Z`,
      provider_metadata: {},
    }];
  });

  const localOverrides = [{
    payment_id: namedCases.movedIn,
    local_occurred_on: "2026-08-01",
    created_by: ADMIN_ID,
    updated_by: ADMIN_ID,
  }, {
    payment_id: namedCases.movedOut,
    local_occurred_on: "2026-07-31",
    created_by: ADMIN_ID,
    updated_by: ADMIN_ID,
  }];

  const paymentFxConversions = [{
    id: fixtureUuid("72000000", 1),
    payment_id: namedCases.foreignConverted,
    original_amount: payments[2].original_amount,
    original_currency: "BHD",
    exchange_rate_to_usd: "2.6500000000",
    amount_usd: "60.950000",
    effective_on: "2026-08-01",
    conversion_source: "Fixture Finance FX evidence",
    reason: "Deterministic equivalence fixture conversion.",
    created_by: ADMIN_ID,
  }];

  const reviewFlags = [{
    id: fixtureUuid("73000000", 1),
    source_area: "b2c_payment",
    source_record_id: namedCases.openFlag,
    flag_type: "needs_follow_up",
    status: "open",
    priority: 2,
    reason: "Fixture needs a verified follow-up.",
    created_by: ADMIN_ID,
  }];

  const duplicateGroups = [{
    id: fixtureUuid("74000000", 1),
    fingerprint: fingerprint(6),
    status: "resolved",
    decision: "keep_one",
    canonical_payment_id: fixtureUuid("70000000", 8),
    detection_reason: "Deterministic duplicate fixture.",
    resolution_reason: "Fixture keeps the independently verified canonical payment.",
    resolved_by: ADMIN_ID,
    resolved_at: "2026-09-01T00:00:00.000Z",
  }];

  const duplicateGroupMembers = [{
    id: fixtureUuid("75000000", 1),
    group_id: duplicateGroups[0].id,
    payment_id: namedCases.duplicateExcluded,
    decision: "exclude",
  }, {
    id: fixtureUuid("75000000", 2),
    group_id: duplicateGroups[0].id,
    payment_id: fixtureUuid("70000000", 8),
    decision: "include",
  }];

  const financeExceptionDecisions = [{
    id: fixtureUuid("76000000", 1),
    payment_id: namedCases.financeException,
    decision: "include",
    reason: "Fixture Finance verified the payment and absence of duplicates.",
    confirmed_provider_transaction: true,
    confirmed_no_known_duplicate: true,
    created_by: ADMIN_ID,
  }];

  return {
    namedCases,
    payments,
    refunds,
    localOverrides,
    paymentFxConversions,
    refundFxConversions: [] as Array<Record<string, unknown>>,
    reviewFlags,
    duplicateGroups,
    duplicateGroupMembers,
    financeExceptionDecisions,
  };
}
