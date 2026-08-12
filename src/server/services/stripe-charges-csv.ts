import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  stripeChargesEvidenceRowSchema,
  type StripeChargesEvidenceRowInput,
} from "@/lib/validation/b2c-finance-import-contracts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_ROWS = 20_000;
const REQUIRED_HEADERS = ["id", "created date (utc)", "amount", "amount refunded", "currency", "captured", "fee", "mode", "status"] as const;
const RETAINED_SOURCE_HEADERS = ["id", "created date (utc)", "amount", "amount refunded", "currency", "captured", "fee", "mode", "status", "description", "paymentintent id", "invoice id", "invoice number", "checkout line item summary", "refunded date (utc)"] as const;

export class StripeChargesCsvError extends Error {}

export type StripeChargesEvidenceRow = StripeChargesEvidenceRowInput;
export type ParsedStripeCharges = {
  sourceFileName: string;
  sourceFileSha256: string;
  rows: StripeChargesEvidenceRow[];
};

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function cleanSourceText(value: string | undefined): string | null {
  const text = value?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function decimal(value: string | undefined, label: string, rowNumber: number, optional = false): string | null {
  const text = cleanSourceText(value);
  if (!text && optional) return null;
  if (!text || !/^\d+(?:\.\d{1,6})?$/.test(text)) throw new StripeChargesCsvError(`Stripe row ${rowNumber} has an invalid ${label}.`);
  return text;
}

function isPositiveDecimal(value: string | null): boolean {
  return Boolean(value && !/^0(?:\.0+)?$/.test(value));
}

function explicitUtcTimestamp(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) || date.toISOString() !== iso ? null : iso;
}

function optionalEmail(value: string | undefined): string | null {
  const email = cleanSourceText(value)?.toLocaleLowerCase("en-US") ?? null;
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function optionalPhone(value: string | undefined): string | null {
  const phone = cleanSourceText(value);
  return phone && /^[0-9+().\-\s]{5,40}$/.test(phone) ? phone : null;
}

function minimizedPayload(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(RETAINED_SOURCE_HEADERS.flatMap((header) => record[header] === undefined ? [] : [[header, record[header]]]));
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
    for (const header of REQUIRED_HEADERS) {
      if (!receivedHeaders.has(header)) throw new StripeChargesCsvError(`The Stripe Charges file is missing the required ${header} header.`);
    }
    return records;
  } catch (error) {
    if (error instanceof StripeChargesCsvError) throw error;
    throw new StripeChargesCsvError("The selected file is not a valid Stripe Charges CSV.");
  }
}

function validateFile(sourceFileName: string, bytes: Uint8Array): void {
  if (!sourceFileName.trim().toLocaleLowerCase("en-US").endsWith(".csv")) throw new StripeChargesCsvError("Only a .csv Stripe Charges file can be uploaded.");
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new StripeChargesCsvError("The Stripe Charges file must be non-empty and no larger than 10 MiB.");
}

/** Parses a Stripe Charges export into minimized, non-reportable evidence entries. */
export function parseStripeChargesCsv(sourceFileName: string, bytes: Uint8Array): ParsedStripeCharges {
  validateFile(sourceFileName, bytes);
  const records = parseRecords(bytes);
  if (records.length === 0) throw new StripeChargesCsvError("The Stripe Charges file has no evidence rows to stage.");
  if (records.length > MAX_SOURCE_ROWS) throw new StripeChargesCsvError("The Stripe Charges file exceeds the maximum of 20,000 evidence rows.");

  const chargeIds = new Set<string>();
  const rows = records.flatMap((record, index) => {
    const sourceRowNumber = index + 2;
    const chargeId = cleanSourceText(record.id);
    if (chargeId) {
      if (chargeIds.has(chargeId)) throw new StripeChargesCsvError(`Stripe row ${sourceRowNumber} has a duplicate charge ID.`);
      chargeIds.add(chargeId);
    }
    const amount = decimal(record.amount, "Amount", sourceRowNumber);
    const amountRefunded = decimal(record["amount refunded"], "Amount Refunded", sourceRowNumber, true);
    decimal(record.fee, "Fee", sourceRowNumber, true);
    const currency = cleanSourceText(record.currency)?.toUpperCase();
    if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new StripeChargesCsvError(`Stripe row ${sourceRowNumber} has an invalid currency.`);
    const status = cleanSourceText(record.status)?.toLocaleLowerCase("en-US") ?? "";
    const captured = cleanSourceText(record.captured)?.toLocaleLowerCase("en-US") === "true";
    const liveMode = cleanSourceText(record.mode)?.toLocaleLowerCase("en-US") === "live";
    const primaryKind = chargeId && liveMode && captured && (status === "paid" || status === "refunded") ? "sale" : "needs_review";
    const createdAtRaw = cleanSourceText(record["created date (utc)"]);
    const refundAtRaw = cleanSourceText(record["refunded date (utc)"]);
    const customerName = cleanSourceText(record["card name"]) ?? cleanSourceText(record["customer description"]);
    const shared = {
      sourceRowNumber,
      chargeId,
      description: cleanSourceText(record.description),
      currency,
      customerName,
      customerEmail: optionalEmail(record["customer email"]),
      customerPhone: optionalPhone(record["customer phone"]),
      rawPayload: minimizedPayload(record),
    };
    const primary = stripeChargesEvidenceRowSchema.parse({
      ...shared,
      sourceEntryKey: "primary",
      kind: primaryKind,
      occurredAt: explicitUtcTimestamp(createdAtRaw),
      occurredAtRaw: createdAtRaw,
      credit: amount,
      debit: null,
    });
    if (primaryKind !== "sale" || !isPositiveDecimal(amountRefunded)) return [primary];
    return [primary, stripeChargesEvidenceRowSchema.parse({
      ...shared,
      sourceEntryKey: "refund",
      kind: "refund",
      occurredAt: explicitUtcTimestamp(refundAtRaw) ?? explicitUtcTimestamp(createdAtRaw),
      occurredAtRaw: refundAtRaw ?? createdAtRaw,
      credit: null,
      debit: amountRefunded,
    })];
  });

  return { sourceFileName: sourceFileName.trim(), sourceFileSha256: createHash("sha256").update(bytes).digest("hex"), rows };
}
