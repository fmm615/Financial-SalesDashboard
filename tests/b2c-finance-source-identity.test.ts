import { describe, expect, it } from "vitest";
import { createFinanceSourceIdentity } from "@/lib/b2c/finance-source-identity";
import { previewFinanceImportVersion } from "@/server/services/b2c-finance-import-versioning";

describe("createFinanceSourceIdentity", () => {
  it("gives the same real payment the same identity across workbook hashes and tabs", () => {
    expect(createFinanceSourceIdentity({
      normalizedCustomerName: "maya al khalifa",
      occurredOn: "2026-08-01",
      amountUsd: "399.000000",
      normalizedPaymentMethod: "bank transfer",
    })).toBe(createFinanceSourceIdentity({
      normalizedCustomerName: "maya al khalifa",
      occurredOn: "2026-08-01",
      amountUsd: "399",
      normalizedPaymentMethod: "bank transfer",
    }));
  });

  it("gives a different identity to a different real payment", () => {
    expect(createFinanceSourceIdentity({
      normalizedCustomerName: "maya al khalifa",
      occurredOn: "2026-08-01",
      amountUsd: "399",
      normalizedPaymentMethod: "bank transfer",
    })).not.toBe(createFinanceSourceIdentity({
      normalizedCustomerName: "maya al khalifa",
      occurredOn: "2026-08-02",
      amountUsd: "399",
      normalizedPaymentMethod: "bank transfer",
    }));
  });
});

describe("previewFinanceImportVersion", () => {
  const priorRow = {
    financeRowId: "10000000-0000-4000-8000-000000000001",
    sourceIdentity: createFinanceSourceIdentity({
      normalizedCustomerName: "maya al khalifa",
      occurredOn: "2026-08-01",
      amountUsd: "399",
      normalizedPaymentMethod: "bank transfer",
    }),
    lineageId: "20000000-0000-4000-8000-000000000001",
  };
  const samePaymentNewRow = {
    financeRowId: "10000000-0000-4000-8000-000000000002",
    sourceIdentity: priorRow.sourceIdentity,
  };

  it("classifies a row retained in a replacement workbook as unchanged", () => {
    const diff = previewFinanceImportVersion({ previous: [priorRow], replacement: [samePaymentNewRow] });
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0]).toMatchObject({
      financeRowId: samePaymentNewRow.financeRowId,
      lineageId: priorRow.lineageId,
      sourceIdentity: priorRow.sourceIdentity,
    });
    expect(diff.newCandidates).toHaveLength(0);
    expect(diff.ambiguousCandidates).toHaveLength(0);
  });

  it("holds repeated same-key rows as ambiguous instead of merging them", () => {
    const sharedIdentity = createFinanceSourceIdentity({
      normalizedCustomerName: "sara ahmed",
      occurredOn: "2026-08-05",
      amountUsd: "50",
      normalizedPaymentMethod: "ios",
    });
    const first = { financeRowId: "10000000-0000-4000-8000-000000000010", sourceIdentity: sharedIdentity };
    const second = { financeRowId: "10000000-0000-4000-8000-000000000011", sourceIdentity: sharedIdentity };
    const third = { financeRowId: "10000000-0000-4000-8000-000000000012", sourceIdentity: sharedIdentity };

    const diff = previewFinanceImportVersion({ previous: [], replacement: [first, second, third] });

    expect(diff.ambiguousCandidates).toHaveLength(3);
    expect(diff.newCandidates).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("holds a later sheet bank row that matches a manual payment for explicit evidence linking", () => {
    const manualIdentity = createFinanceSourceIdentity({
      normalizedCustomerName: "noor al sabah",
      occurredOn: "2026-08-09",
      amountUsd: "1200",
      normalizedPaymentMethod: "bank transfer",
    });
    const sheetBankRow = { financeRowId: "10000000-0000-4000-8000-000000000020", sourceIdentity: manualIdentity };
    const manualBankPayment = {
      paymentId: "30000000-0000-4000-8000-000000000001",
      lineageId: "20000000-0000-4000-8000-000000000002",
      sourceIdentity: manualIdentity,
    };

    const diff = previewFinanceImportVersion({ previous: [], replacement: [sheetBankRow], representedPayments: [manualBankPayment] });

    expect(diff.existingPaymentCandidates).toHaveLength(1);
    expect(diff.existingPaymentCandidates[0]).toMatchObject({
      financeRowIds: [sheetBankRow.financeRowId],
      sourceIdentity: manualIdentity,
      priorPaymentIds: [manualBankPayment.paymentId],
      priorLineageIds: [manualBankPayment.lineageId],
    });
    expect(diff.newCandidates).toHaveLength(0);
    expect(diff.ambiguousCandidates).toHaveLength(0);
  });

  it("classifies a previous-import identity absent from the replacement as removed", () => {
    const diff = previewFinanceImportVersion({ previous: [priorRow], replacement: [] });

    expect(diff.removedCandidates).toHaveLength(1);
    expect(diff.removedCandidates[0]).toMatchObject({
      financeRowIds: [priorRow.financeRowId],
      sourceIdentity: priorRow.sourceIdentity,
      priorLineageIds: [priorRow.lineageId],
    });
  });

  it("classifies a first-ever identity with no prior row or represented payment as new", () => {
    const newIdentity = createFinanceSourceIdentity({
      normalizedCustomerName: "layla hassan",
      occurredOn: "2026-08-11",
      amountUsd: "80",
      normalizedPaymentMethod: "ios",
    });
    const row = { financeRowId: "10000000-0000-4000-8000-000000000030", sourceIdentity: newIdentity };

    const diff = previewFinanceImportVersion({ previous: [], replacement: [row] });

    expect(diff.newCandidates).toHaveLength(1);
    expect(diff.newCandidates[0]).toMatchObject({ financeRowIds: [row.financeRowId], sourceIdentity: newIdentity });
  });
});
