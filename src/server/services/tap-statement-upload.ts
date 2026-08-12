import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "@/lib/supabase/server";
import { TAP_STATEMENT_MIME_TYPE, TAP_STATEMENT_STORAGE_BUCKET } from "@/lib/validation/tap-statement-upload-contracts";
import type { TapEvidenceKind } from "@/server/services/b2c-finance-reconciliation";
import { parseTapStatementCsv, type ParsedTapStatement } from "@/server/services/tap-statement-csv";
import type { Json } from "@/types/database.generated";

export class TapStatementUploadError extends Error {}

export type TapStatementPreview = {
  sourceFileSha256: string;
  totalRows: number;
  kindCounts: Record<TapEvidenceKind, number>;
  missingPaymentIdSales: number;
  unparsedDates: number;
};

async function readTapFile(file: File): Promise<ParsedTapStatement> {
  return parseTapStatementCsv(file.name, new Uint8Array(await file.arrayBuffer()));
}

function buildPreview(statement: ParsedTapStatement): TapStatementPreview {
  const kindCounts: Record<TapEvidenceKind, number> = {
    sale: 0, processing_fee: 0, fee_vat: 0, refund: 0, transfer: 0, opening_balance: 0, needs_review: 0,
  };
  for (const row of statement.rows) kindCounts[row.kind] += 1;
  return {
    sourceFileSha256: statement.sourceFileSha256,
    totalRows: statement.rows.length,
    kindCounts,
    missingPaymentIdSales: statement.rows.filter((row) => row.kind === "needs_review" && row.description?.toLocaleLowerCase("en-US").startsWith("sale -")).length,
    unparsedDates: statement.rows.filter((row) => !row.occurredAt).length,
  };
}

/** Parses one Tap statement in memory and returns only non-financial evidence counts. */
export async function previewTapStatementUpload(file: File): Promise<TapStatementPreview> {
  return buildPreview(await readTapFile(file));
}

/** Stores a confirmed source CSV and stages all Tap evidence rows atomically. */
export async function finalizeTapStatementUpload(client: DatabaseClient, file: File, expectedFileSha256: string): Promise<string> {
  const statement = await readTapFile(file);
  if (statement.sourceFileSha256 !== expectedFileSha256) throw new TapStatementUploadError("The selected file changed after its preview. Preview it again before staging.");
  const sourceStoragePath = `tap-statement/${statement.sourceFileSha256}/${randomUUID()}.csv`;
  const storage = client.storage.from(TAP_STATEMENT_STORAGE_BUCKET);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: storageError } = await storage.upload(sourceStoragePath, bytes, { contentType: TAP_STATEMENT_MIME_TYPE, upsert: false });
  if (storageError) throw new TapStatementUploadError("The original Tap statement file could not be stored privately.");
  try {
    const { data, error } = await client.rpc("finalize_tap_statement_import", {
      p_source_file_name: statement.sourceFileName,
      p_source_file_sha256: statement.sourceFileSha256,
      p_source_storage_bucket: TAP_STATEMENT_STORAGE_BUCKET,
      p_source_storage_path: sourceStoragePath,
      p_rows: statement.rows.map((row) => ({
        sourceRowNumber: row.sourceRowNumber,
        postingId: row.postingId,
        paymentId: row.paymentId ?? "",
        refundId: row.refundId ?? "",
        kind: row.kind,
        description: row.description ?? "",
        occurredAt: row.occurredAt ?? "",
        occurredAtRaw: row.occurredAtRaw ?? "",
        currency: row.currency,
        credit: row.credit ?? "",
        debit: row.debit ?? "",
        rawPayload: row.rawPayload as Json,
      })) as Json,
    });
    if (error || !data) throw new Error("Tap statement finalization failed.");
    return data;
  } catch {
    await storage.remove([sourceStoragePath]).catch(() => undefined);
    throw new TapStatementUploadError("The Tap statement could not be staged. No reportable B2C revenue was created.");
  }
}
