import { randomUUID } from "node:crypto";
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
import { parsePaymentTrackerWorkbook } from "@/server/services/payment-tracker-workbook";

export class PaymentTrackerUploadError extends Error {}

export type PaymentTrackerPreview = {
  sourceFileSha256: string;
  acceptedTabs: ["B2C", "B2C Cons"];
  summary: FinanceImportAssessment["summary"];
  issueCounts: Record<string, number>;
  duplicateCandidates: { exact: number; possible: number; conflicts: number };
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

function buildPreview(parsed: Awaited<ReturnType<typeof readWorkbookFile>>): PaymentTrackerPreview {
  const assessment = assessWorkbook(parsed);
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
  };
}

/** Reads only in memory and returns counts; no Storage or database write is possible here. */
export async function previewPaymentTrackerUpload(file: File): Promise<PaymentTrackerPreview> {
  return buildPreview(await readWorkbookFile(file));
}

/** Stores an Admin-confirmed source file, then stages its validated rows atomically. */
export async function finalizePaymentTrackerUpload(client: DatabaseClient, file: File, expectedFileSha256: string): Promise<string> {
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
    return await new SupabaseB2cFinanceReconciliationRepository(client).finalizeFinanceImport({
      sourceFileName: parsed.sourceFileName,
      sourceFileSha256: parsed.sourceFileSha256,
      sourceStorageBucket: PAYMENT_TRACKER_STORAGE_BUCKET,
      sourceStoragePath,
      rows: parsed.rows,
    }, assessment);
  } catch {
    await storage.remove([sourceStoragePath]).catch(() => undefined);
    throw new PaymentTrackerUploadError("The Payment Tracker could not be staged. No reportable B2C revenue was created.");
  }
}
