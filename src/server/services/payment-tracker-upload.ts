import { randomUUID } from "node:crypto";
import { createFinanceSourceIdentity } from "@/lib/b2c/finance-source-identity";
import type { DatabaseClient } from "@/lib/supabase/server";
import {
  PAYMENT_TRACKER_MIME_TYPE,
  PAYMENT_TRACKER_STORAGE_BUCKET,
} from "@/lib/validation/payment-tracker-upload-contracts";
import { SupabaseB2cFinanceReconciliationRepository } from "@/server/repositories/b2c-finance-reconciliation-repository";
import {
  assessFinanceImport,
  type FinanceImportAssessment,
} from "@/server/services/b2c-finance-reconciliation";
import {
  previewFinanceImportVersion,
  summarizeFinanceMethods,
  toPersistableFinanceImportCandidates,
  type FinanceImportDiff,
  type FinanceImportVersionReplacementRow,
  type FinanceMethodSummary,
} from "@/server/services/b2c-finance-import-versioning";
import { parsePaymentTrackerWorkbook } from "@/server/services/payment-tracker-workbook";

export class PaymentTrackerUploadError extends Error {}

export type PaymentTrackerVersionDiffSummary = {
  unchangedCount: number;
  newCount: number;
  removedCount: number;
  ambiguousCount: number;
  existingPaymentCount: number;
};

export type PaymentTrackerPreview = {
  sourceFileSha256: string;
  acceptedTabs: ["B2C", "B2C Cons"];
  summary: FinanceImportAssessment["summary"];
  issueCounts: Record<string, number>;
  duplicateCandidates: { exact: number; possible: number; conflicts: number };
  methodSummary: FinanceMethodSummary;
  versionDiff: PaymentTrackerVersionDiffSummary;
};

async function readWorkbookFile(file: File) {
  return parsePaymentTrackerWorkbook(file.name, new Uint8Array(await file.arrayBuffer()));
}

function assessWorkbook(parsed: Awaited<ReturnType<typeof readWorkbookFile>>) {
  return assessFinanceImport({
    sourceFileName: parsed.sourceFileName,
    sourceFileSha256: parsed.sourceFileSha256,
    sourceStorageBucket: PAYMENT_TRACKER_STORAGE_BUCKET,
    sourceStoragePath: "preview-only",
    rows: parsed.rows,
  });
}

function countDuplicateCandidates(assessment: FinanceImportAssessment): PaymentTrackerPreview["duplicateCandidates"] {
  const exactCounts = new Map<string, number>();
  const sameDayCounts = new Map<string, number>();
  const recurringDateCounts = new Map<string, Map<number, number>>();
  let exact = 0;
  let possible = 0;
  let conflicts = 0;

  for (const row of assessment.rows) {
    if (row.quality !== "valid" || !row.occurredOn || !row.amountUsd || !row.normalizedCustomerName || !row.normalizedPaymentMethod) continue;
    const identity = row.normalizedCustomerEmail ?? row.normalizedCustomerName;
    const dateKey = `${identity}\u0000${row.occurredOn}`;
    const exactKey = `${dateKey}\u0000${row.amountUsd}\u0000${row.normalizedPaymentMethod}`;
    const sameDay = sameDayCounts.get(dateKey) ?? 0;
    const sameExact = exactCounts.get(exactKey) ?? 0;
    exact += sameExact;
    conflicts += sameDay - sameExact;
    sameDayCounts.set(dateKey, sameDay + 1);
    exactCounts.set(exactKey, sameExact + 1);

    const day = Math.floor(Date.parse(`${row.occurredOn}T00:00:00.000Z`) / 86_400_000);
    const recurringKey = `${identity}\u0000${row.amountUsd}\u0000${row.normalizedPaymentMethod}`;
    const dateCounts = recurringDateCounts.get(recurringKey) ?? new Map<number, number>();
    dateCounts.set(day, (dateCounts.get(day) ?? 0) + 1);
    recurringDateCounts.set(recurringKey, dateCounts);
  }
  for (const dateCounts of recurringDateCounts.values()) {
    for (const day of [...dateCounts.keys()].sort((left, right) => left - right)) {
      for (let offset = 1; offset <= 3; offset += 1) {
        possible += (dateCounts.get(day) ?? 0) * (dateCounts.get(day - offset) ?? 0);
      }
    }
  }

  return { exact, possible, conflicts };
}

/** A row's prospective identity; `null` when the row is too incomplete to identify. */
function buildReplacementRows(assessment: FinanceImportAssessment, rowIds: string[]): FinanceImportVersionReplacementRow[] {
  return assessment.rows.map((row, index) => ({
    financeRowId: rowIds[index],
    sourceIdentity: row.normalizedCustomerName && row.occurredOn && row.amountUsd && row.normalizedPaymentMethod
      ? createFinanceSourceIdentity({
        normalizedCustomerName: row.normalizedCustomerName,
        occurredOn: row.occurredOn,
        amountUsd: row.amountUsd,
        normalizedPaymentMethod: row.normalizedPaymentMethod,
      })
      : null,
  }));
}

/** Compares this workbook against the declared prior import and any existing manual bank payments. */
async function diffAgainstPriorVersion(
  client: DatabaseClient,
  assessment: FinanceImportAssessment,
  rowIds: string[],
  supersedesImportId: string | null,
): Promise<FinanceImportDiff> {
  const { previous, representedPayments } = await new SupabaseB2cFinanceReconciliationRepository(client)
    .getPaymentTrackerVersionState(supersedesImportId);
  return previewFinanceImportVersion({ previous, replacement: buildReplacementRows(assessment, rowIds), representedPayments });
}

function summarizeVersionDiff(diff: FinanceImportDiff): PaymentTrackerVersionDiffSummary {
  return {
    unchangedCount: diff.unchanged.length,
    newCount: diff.newCandidates.length,
    removedCount: diff.removedCandidates.length,
    ambiguousCount: diff.ambiguousCandidates.length,
    existingPaymentCount: diff.existingPaymentCandidates.length,
  };
}

/** Reads in memory and safely counts against prior staged state; it never writes to Storage or the database. */
export async function previewPaymentTrackerUpload(client: DatabaseClient, file: File, supersedesImportId: string | null): Promise<PaymentTrackerPreview> {
  const parsed = await readWorkbookFile(file);
  const assessment = assessWorkbook(parsed);
  const rowIds = assessment.rows.map(() => randomUUID());
  const diff = await diffAgainstPriorVersion(client, assessment, rowIds, supersedesImportId);

  const issueCounts: Record<string, number> = {};
  for (const row of assessment.rows) {
    for (const issue of row.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
  }

  return {
    sourceFileSha256: parsed.sourceFileSha256,
    acceptedTabs: parsed.acceptedTabs,
    summary: assessment.summary,
    issueCounts,
    duplicateCandidates: countDuplicateCandidates(assessment),
    methodSummary: summarizeFinanceMethods(assessment.rows),
    versionDiff: summarizeVersionDiff(diff),
  };
}

/** Stores an Admin-confirmed source file, then stages its validated rows and version-diff candidates atomically. */
export async function finalizePaymentTrackerUpload(
  client: DatabaseClient,
  file: File,
  expectedFileSha256: string,
  supersedesImportId: string | null,
): Promise<string> {
  const parsed = await readWorkbookFile(file);
  if (parsed.sourceFileSha256 !== expectedFileSha256) {
    throw new PaymentTrackerUploadError("The selected file changed after its preview. Preview it again before staging.");
  }
  const sourceStoragePath = `payment-tracker/${parsed.sourceFileSha256}/${randomUUID()}.xlsx`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const storage = client.storage.from(PAYMENT_TRACKER_STORAGE_BUCKET);
  const { error: storageError } = await storage.upload(sourceStoragePath, bytes, {
    contentType: PAYMENT_TRACKER_MIME_TYPE,
    upsert: false,
  });
  if (storageError) throw new PaymentTrackerUploadError("The original Payment Tracker file could not be stored privately.");

  try {
    const assessment = assessWorkbook(parsed);
    const rowIds = assessment.rows.map(() => randomUUID());
    const diff = await diffAgainstPriorVersion(client, assessment, rowIds, supersedesImportId);
    const candidates = toPersistableFinanceImportCandidates(diff);
    return await new SupabaseB2cFinanceReconciliationRepository(client).finalizeFinanceImportVersion(
      {
        sourceFileName: parsed.sourceFileName,
        sourceFileSha256: parsed.sourceFileSha256,
        sourceStorageBucket: PAYMENT_TRACKER_STORAGE_BUCKET,
        sourceStoragePath,
        rows: parsed.rows,
      },
      assessment,
      rowIds,
      { supersedesImportId, unchanged: diff.unchanged, candidates },
    );
  } catch {
    await storage.remove([sourceStoragePath]).catch(() => undefined);
    throw new PaymentTrackerUploadError("The Payment Tracker could not be staged. No reportable B2C revenue was created.");
  }
}
