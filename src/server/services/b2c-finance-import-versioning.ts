import { normalizeApprovedFinancePaymentMethod } from "@/lib/b2c/approved-finance-payment";

/** A prior import's staging row, already linked to a stable lineage. */
export type FinanceImportVersionPreviousRow = {
  financeRowId: string;
  sourceIdentity: string;
  lineageId: string;
};

/** A replacement workbook's staging row. `sourceIdentity` is null when the row is too incomplete to identify (still staged for audit, never diffed). */
export type FinanceImportVersionReplacementRow = {
  financeRowId: string;
  sourceIdentity: string | null;
};

/** A payment already representing this identity outside the Payment Tracker workbook, e.g. a manual bank transfer. */
export type FinanceImportVersionRepresentedPayment = {
  paymentId: string;
  lineageId: string;
  sourceIdentity: string;
};

export type FinanceImportVersionInput = {
  previous: FinanceImportVersionPreviousRow[];
  replacement: FinanceImportVersionReplacementRow[];
  representedPayments?: FinanceImportVersionRepresentedPayment[];
};

export type FinanceImportCandidate = {
  candidateId: string;
  financeRowIds: string[];
  sourceIdentity: string;
  priorLineageIds: string[];
  priorPaymentIds: string[];
  reason: string;
};

export type FinanceImportRowMatch = {
  financeRowId: string;
  lineageId: string;
  sourceIdentity: string;
};

export type FinanceImportDiff = {
  unchanged: FinanceImportRowMatch[];
  newCandidates: FinanceImportCandidate[];
  removedCandidates: FinanceImportCandidate[];
  ambiguousCandidates: FinanceImportCandidate[];
  existingPaymentCandidates: FinanceImportCandidate[];
};

export type FinanceMethodSummary = {
  iosRows: number;
  bankTransferRows: number;
  unsupportedRows: number;
};

function groupByIdentity<T extends { sourceIdentity: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.sourceIdentity) ?? [];
    bucket.push(row);
    grouped.set(row.sourceIdentity, bucket);
  }
  return grouped;
}

/**
 * Compares a replacement Payment Tracker workbook against the prior completed import's
 * lineaged rows and any payments that already represent an identity outside the workbook
 * (manual bank transfers). Never merges same-identity rows within one side into a single
 * candidate: repeated keys stay ambiguous work items an Admin must resolve individually.
 */
export function previewFinanceImportVersion(input: FinanceImportVersionInput): FinanceImportDiff {
  const previousByIdentity = groupByIdentity(input.previous);
  const representedByIdentity = new Map((input.representedPayments ?? []).map((payment) => [payment.sourceIdentity, payment]));
  const replacementRows = input.replacement.filter((row): row is FinanceImportVersionReplacementRow & { sourceIdentity: string } => row.sourceIdentity !== null);
  const replacementByIdentity = groupByIdentity(replacementRows);

  const unchanged: FinanceImportRowMatch[] = [];
  const newCandidates: FinanceImportCandidate[] = [];
  const ambiguousCandidates: FinanceImportCandidate[] = [];
  const existingPaymentCandidates: FinanceImportCandidate[] = [];
  let sequence = 0;
  const nextCandidateId = (kind: string, identity: string) => {
    sequence += 1;
    return `${kind}:${identity}:${sequence}`;
  };

  for (const [identity, rows] of replacementByIdentity) {
    const priorRows = previousByIdentity.get(identity) ?? [];
    const representedPayment = representedByIdentity.get(identity) ?? null;

    if (rows.length > 1 || priorRows.length > 1) {
      for (const row of rows) {
        ambiguousCandidates.push({
          candidateId: nextCandidateId("ambiguous", identity),
          financeRowIds: [row.financeRowId],
          sourceIdentity: identity,
          priorLineageIds: priorRows.map((prior) => prior.lineageId),
          priorPaymentIds: representedPayment ? [representedPayment.paymentId] : [],
          reason: "Multiple rows share the same payment identity and cannot be merged automatically.",
        });
      }
      continue;
    }

    const row = rows[0];
    if (priorRows.length === 1) {
      unchanged.push({ financeRowId: row.financeRowId, lineageId: priorRows[0].lineageId, sourceIdentity: identity });
      continue;
    }

    if (representedPayment) {
      existingPaymentCandidates.push({
        candidateId: nextCandidateId("existing_payment", identity),
        financeRowIds: [row.financeRowId],
        sourceIdentity: identity,
        priorLineageIds: [representedPayment.lineageId],
        priorPaymentIds: [representedPayment.paymentId],
        reason: "This identity matches an existing manual bank transfer payment.",
      });
      continue;
    }

    newCandidates.push({
      candidateId: nextCandidateId("new", identity),
      financeRowIds: [row.financeRowId],
      sourceIdentity: identity,
      priorLineageIds: [],
      priorPaymentIds: [],
      reason: "No prior Payment Tracker row or existing payment shares this identity.",
    });
  }

  const removedCandidates: FinanceImportCandidate[] = [];
  for (const [identity, priorRows] of previousByIdentity) {
    if (replacementByIdentity.has(identity)) continue;
    removedCandidates.push({
      candidateId: nextCandidateId("removed", identity),
      financeRowIds: priorRows.map((row) => row.financeRowId),
      sourceIdentity: identity,
      priorLineageIds: priorRows.map((row) => row.lineageId),
      priorPaymentIds: [],
      reason: "This identity from the previous import is not present in the replacement workbook.",
    });
  }

  return { unchanged, newCandidates, removedCandidates, ambiguousCandidates, existingPaymentCandidates };
}

/** Counts accepted rows by supported Finance posting method; never a financial total. */
export function summarizeFinanceMethods(rows: Array<{ normalizedPaymentMethod: string | null }>): FinanceMethodSummary {
  let iosRows = 0;
  let bankTransferRows = 0;
  let unsupportedRows = 0;
  for (const row of rows) {
    const method = normalizeApprovedFinancePaymentMethod(row.normalizedPaymentMethod);
    if (method === "ios") iosRows += 1;
    else if (method === "bank_transfer") bankTransferRows += 1;
    else unsupportedRows += 1;
  }
  return { iosRows, bankTransferRows, unsupportedRows };
}

/** A candidate ready for persistence: merged so at most one row exists per (kind, identity) per import, matching the unique database constraint. */
export type PersistableFinanceImportCandidate = {
  candidateKind: "new" | "removed" | "ambiguous" | "existing_payment";
  sourceIdentity: string;
  financeRowIds: string[];
  priorLineageIds: string[];
  priorPaymentIds: string[];
};

/** Merges the pure diff's per-row candidates into one persisted row per identity within each kind. */
export function toPersistableFinanceImportCandidates(diff: FinanceImportDiff): PersistableFinanceImportCandidate[] {
  const merged = new Map<string, PersistableFinanceImportCandidate>();
  const kinds: Array<[FinanceImportCandidate[], PersistableFinanceImportCandidate["candidateKind"]]> = [
    [diff.newCandidates, "new"],
    [diff.removedCandidates, "removed"],
    [diff.ambiguousCandidates, "ambiguous"],
    [diff.existingPaymentCandidates, "existing_payment"],
  ];

  for (const [candidates, candidateKind] of kinds) {
    for (const candidate of candidates) {
      const key = `${candidateKind}:${candidate.sourceIdentity}`;
      const existing = merged.get(key);
      if (existing) {
        existing.financeRowIds = [...new Set([...existing.financeRowIds, ...candidate.financeRowIds])];
        existing.priorLineageIds = [...new Set([...existing.priorLineageIds, ...candidate.priorLineageIds])];
        existing.priorPaymentIds = [...new Set([...existing.priorPaymentIds, ...candidate.priorPaymentIds])];
        continue;
      }
      merged.set(key, {
        candidateKind,
        sourceIdentity: candidate.sourceIdentity,
        financeRowIds: [...candidate.financeRowIds],
        priorLineageIds: [...candidate.priorLineageIds],
        priorPaymentIds: [...candidate.priorPaymentIds],
      });
    }
  }

  return [...merged.values()];
}
