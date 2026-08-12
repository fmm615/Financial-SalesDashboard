import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  tapStatementEvidenceRowSchema,
  type TapStatementEvidenceRowInput,
} from "@/lib/validation/b2c-finance-import-contracts";
import { classifyTapEvidence, type TapEvidenceKind } from "@/server/services/b2c-finance-reconciliation";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_STATEMENT_ROWS = 20_000;
const requiredHeaders = ["postdate", "txndate", "description", "currency", "debit", "credit", "posting_id", "charge_id", "refund_id"] as const;

export class TapStatementCsvError extends Error {}

export type TapStatementRow = TapStatementEvidenceRowInput;

export type ParsedTapStatement = {
  sourceFileName: string;
  sourceFileSha256: string;
  rows: TapStatementRow[];
};

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function cleanSourceText(value: string | undefined): string | null {
  const text = value?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function decimal(value: string | undefined, name: "debit" | "credit", rowNumber: number): string | null {
  const text = cleanSourceText(value);
  if (!text) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) {
    throw new TapStatementCsvError(`Tap row ${rowNumber} has an invalid ${name} amount.`);
  }
  return text;
}

/** Tap's d/m/yy timestamps are retained as raw source text; only ISO UTC values are safe to parse automatically. */
function unambiguousTimestamp(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function validateFile(sourceFileName: string, bytes: Uint8Array): void {
  if (!sourceFileName.trim().toLocaleLowerCase("en-US").endsWith(".csv")) throw new TapStatementCsvError("Only a .csv Tap statement file can be uploaded.");
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new TapStatementCsvError("The Tap statement file must be non-empty and no larger than 10 MiB.");
}

function parseRecords(bytes: Uint8Array): Array<Record<string, string>> {
  try {
    let receivedHeaders = new Set<string>();
    const records = parse(Buffer.from(bytes).toString("utf8"), {
      bom: true,
      columns: (headers: string[]) => {
        receivedHeaders = new Set(headers.map(normalizedHeader));
        return headers.map(normalizedHeader);
      },
      skip_empty_lines: true,
      relax_column_count: false,
      trim: false,
    }) as Array<Record<string, string>>;
    for (const header of requiredHeaders) {
      if (!receivedHeaders.has(header)) throw new TapStatementCsvError(`The Tap statement is missing the required ${header} header.`);
    }
    return records;
  } catch (error) {
    if (error instanceof TapStatementCsvError) throw error;
    throw new TapStatementCsvError("The selected file is not a valid Tap statement CSV.");
  }
}

/** Parses every Tap statement line as evidence; it does not convert currency or create financial sales. */
export function parseTapStatementCsv(sourceFileName: string, bytes: Uint8Array): ParsedTapStatement {
  validateFile(sourceFileName, bytes);
  const records = parseRecords(bytes);
  if (records.length === 0) throw new TapStatementCsvError("The Tap statement has no evidence rows to stage.");
  if (records.length > MAX_STATEMENT_ROWS) throw new TapStatementCsvError("The Tap statement exceeds the maximum of 20,000 evidence rows.");
  const postingIds = new Set<string>();
  const rows = records.map((record, index) => {
    const sourceRowNumber = index + 2;
    const postingId = cleanSourceText(record.posting_id);
    if (!postingId) throw new TapStatementCsvError(`Tap row ${sourceRowNumber} is missing posting_id.`);
    if (postingIds.has(postingId)) throw new TapStatementCsvError(`Tap row ${sourceRowNumber} has a duplicate posting_id.`);
    postingIds.add(postingId);

    const description = cleanSourceText(record.description);
    const paymentId = cleanSourceText(record.charge_id);
    const refundId = cleanSourceText(record.refund_id);
    const currency = cleanSourceText(record.currency)?.toUpperCase();
    if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new TapStatementCsvError(`Tap row ${sourceRowNumber} has an invalid currency.`);
    const classified = classifyTapEvidence({
      description,
      chargeId: paymentId,
      refundId,
      currency,
      debit: cleanSourceText(record.debit),
      credit: cleanSourceText(record.credit),
    });
    const occurredAtRaw = cleanSourceText(record.txndate) ?? cleanSourceText(record.postdate);
    return tapStatementEvidenceRowSchema.parse({
      sourceRowNumber,
      postingId,
      paymentId,
      refundId,
      kind: classified.kind as TapEvidenceKind,
      description,
      occurredAt: unambiguousTimestamp(occurredAtRaw),
      occurredAtRaw,
      currency,
      credit: decimal(record.credit, "credit", sourceRowNumber),
      debit: decimal(record.debit, "debit", sourceRowNumber),
      rawPayload: record,
    });
  });
  return {
    sourceFileName: sourceFileName.trim(),
    sourceFileSha256: createHash("sha256").update(bytes).digest("hex"),
    rows,
  };
}
