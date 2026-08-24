/**
 * Inputs whose hashes cross the TypeScript/PostgreSQL boundary during manual
 * bank-transfer review and confirmation. The tracked SQL fixture and pgTAP
 * calls use these same literal values; add a case when a new normalization
 * shape enters the live form.
 */
export const b2cHashParityCorpus = [
  {
    key: "standard",
    duplicateFingerprint: {
      customerEmail: "MEMBER@Playbook.test",
      amountUsd: "266.000000",
      originalCurrency: "USD",
      categoryCode: "Membership",
      occurredOn: "2026-09-01",
      providerTransactionId: "PARITY-REF-1",
    },
    reviewedInput: {
      bankReference: "PARITY-REF-1",
      customerEmail: "member@playbook.test",
      customerName: "Ada Founder",
      categoryCode: "Membership",
      membershipTier: null,
      amountUsd: "266.000000",
      receivedAtRaw: "2026-09-01T08:30:00+03:00",
      occurredOn: "2026-09-01",
      reason: "Golden parity fixture for a standard transfer.",
    },
  },
  {
    key: "membership-tier-and-zulu-offset",
    duplicateFingerprint: {
      customerEmail: "  finance.parity@example.com  ",
      amountUsd: "75.500000",
      originalCurrency: "usd",
      categoryCode: "  WORKSHOP  ",
      // 21:15 UTC is already the next business date in Bahrain.
      occurredOn: "2026-09-03",
      providerTransactionId: "PARITY-REF-2",
    },
    reviewedInput: {
      bankReference: "PARITY-REF-2",
      customerEmail: "finance.parity@example.com",
      customerName: "Maya Al Khalifa",
      categoryCode: "WORKSHOP",
      membershipTier: "annual",
      amountUsd: "75.500000",
      receivedAtRaw: "2026-09-02T21:15:00Z",
      occurredOn: "2026-09-03",
      reason: "Golden parity fixture with a tier and Zulu offset.",
    },
  },
] as const;
