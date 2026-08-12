import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { FinanceWorkbookRowInput } from "@/lib/validation/b2c-finance-import-contracts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_ROWS = 20_000;
const MAX_HEADER_SCAN_ROWS = 10;
const acceptedTabs = ["B2C", "B2C Cons"] as const;

type AcceptedTab = typeof acceptedTabs[number];
type ParsedWorkbookRow = FinanceWorkbookRowInput & { rawPayload: Record<string, unknown> };
type RawFinanceField = Exclude<keyof FinanceWorkbookRowInput, "sourceTab" | "sourceRowNumber">;
type WorkbookColumn = { header: string; field: RawFinanceField };

const workbookColumns: Record<AcceptedTab, WorkbookColumn[]> = {
  B2C: [
    { header: "Date", field: "reportedDateRaw" },
    { header: "Amount USD", field: "amountUsdRaw" },
    { header: "Name", field: "customerNameRaw" },
    { header: "Mobile", field: "customerPhoneRaw" },
    { header: "Type", field: "categoryRaw" },
    { header: "Pay Method", field: "paymentMethodRaw" },
    { header: "Payment Status", field: "paymentStatusRaw" },
    { header: "year", field: "declaredYear" },
    { header: "Note", field: "noteRaw" },
  ],
  "B2C Cons": [
    { header: "Date", field: "reportedDateRaw" },
    { header: "Amount", field: "amountUsdRaw" },
    { header: "Name", field: "customerNameRaw" },
    { header: "Mobile", field: "customerPhoneRaw" },
    { header: "Category", field: "categoryRaw" },
    { header: "Membership Type", field: "membershipTypeRaw" },
    { header: "Pay Method", field: "paymentMethodRaw" },
    { header: "Payment Status", field: "paymentStatusRaw" },
    { header: "Month", field: "declaredMonth" },
    { header: "Year", field: "declaredYear" },
    { header: "Note", field: "noteRaw" },
  ],
};

const requiredHeaders = new Set(["date", "amount usd", "amount", "name", "pay method"]);

export class PaymentTrackerWorkbookError extends Error {}

export type ParsedPaymentTrackerWorkbook = {
  sourceFileName: string;
  sourceFileSha256: string;
  acceptedTabs: ["B2C", "B2C Cons"];
  rows: ParsedWorkbookRow[];
};

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function isoDate(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function displayedValue(value: ExcelJS.CellValue | null | undefined, location: string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isoDate(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (typeof value === "object" && "formula" in value) {
    if (value.result === undefined || value.result === null) {
      throw new PaymentTrackerWorkbookError(`${location} contains a formula without a cached displayed value.`);
    }
    return displayedValue(value.result as ExcelJS.CellValue, location);
  }
  if (typeof value === "object" && "richText" in value) return value.richText.map((part) => part.text).join("").trim();
  if (typeof value === "object" && "text" in value) return value.text.trim();
  throw new PaymentTrackerWorkbookError(`${location} contains an unsupported cell value.`);
}

function validateFile(sourceFileName: string, bytes: Uint8Array): void {
  if (!sourceFileName.trim().toLocaleLowerCase("en-US").endsWith(".xlsx")) {
    throw new PaymentTrackerWorkbookError("Only a .xlsx Payment Tracker file can be uploaded.");
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    throw new PaymentTrackerWorkbookError("The Payment Tracker file must be non-empty and no larger than 10 MiB.");
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new PaymentTrackerWorkbookError("The selected file is not a valid XLSX workbook.");
  }
}

/** Finance supplies `B2C cons`; capitalization alone does not change tab meaning. */
function approvedWorksheet(workbook: ExcelJS.Workbook, tab: AcceptedTab): ExcelJS.Worksheet | undefined {
  return workbook.worksheets.find((worksheet) => normalizeHeader(worksheet.name) === normalizeHeader(tab));
}

function findHeaderRow(worksheet: ExcelJS.Worksheet, tab: AcceptedTab): { rowNumber: number; indexes: Map<string, number> } {
  const expected = new Map(workbookColumns[tab].map((column) => [normalizeHeader(column.header), column]));
  const requiredForTab = workbookColumns[tab].filter((column) => requiredHeaders.has(normalizeHeader(column.header)));
  const lastHeaderRow = Math.min(worksheet.rowCount, MAX_HEADER_SCAN_ROWS);

  for (let rowNumber = 1; rowNumber <= lastHeaderRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const indexes = new Map<string, number>();
    let hasContent = false;
    for (let index = 1; index <= row.cellCount; index += 1) {
      const value = displayedValue(row.getCell(index).value, `${tab} row ${rowNumber}, column ${index}`);
      if (!value) continue;
      hasContent = true;
      const normalized = normalizeHeader(value);
      if (!expected.has(normalized)) continue;
      if (indexes.has(normalized) && requiredHeaders.has(normalized)) {
        throw new PaymentTrackerWorkbookError(`${tab} contains a repeated required header: ${value}.`);
      }
      if (!indexes.has(normalized)) indexes.set(normalized, index);
    }
    if (hasContent && requiredForTab.every((column) => indexes.has(normalizeHeader(column.header)))) return { rowNumber, indexes };
  }

  const missing = workbookColumns[tab]
    .filter((column) => requiredHeaders.has(normalizeHeader(column.header)))
    .map((column) => column.header)
    .join(", ");
  throw new PaymentTrackerWorkbookError(`${tab} is missing a required header. Expected: ${missing}.`);
}

function rowHasContent(row: ExcelJS.Row, tab: AcceptedTab): boolean {
  for (let index = 1; index <= row.cellCount; index += 1) {
    if (displayedValue(row.getCell(index).value, `${tab} row ${row.number}, column ${index}`)) return true;
  }
  return false;
}

function extractRows(worksheet: ExcelJS.Worksheet, tab: AcceptedTab): ParsedWorkbookRow[] {
  const { rowNumber: headerRowNumber, indexes } = findHeaderRow(worksheet, tab);
  const rows: ParsedWorkbookRow[] = [];

  for (let sourceRowNumber = headerRowNumber + 1; sourceRowNumber <= worksheet.rowCount; sourceRowNumber += 1) {
    const sourceRow = worksheet.getRow(sourceRowNumber);
    if (!rowHasContent(sourceRow, tab)) continue;
    const rawPayload: Record<string, unknown> = {};
    const source: Record<RawFinanceField, string | null> = {
      reportedDateRaw: null,
      declaredMonth: null,
      declaredYear: null,
      amountUsdRaw: null,
      customerNameRaw: null,
      customerEmailRaw: null,
      customerPhoneRaw: null,
      categoryRaw: null,
      membershipTypeRaw: null,
      paymentMethodRaw: null,
      paymentStatusRaw: null,
      noteRaw: null,
    };
    for (const column of workbookColumns[tab]) {
      const headerKey = normalizeHeader(column.header);
      const index = indexes.get(headerKey);
      const value = index === undefined ? null : displayedValue(sourceRow.getCell(index).value, `${tab} row ${sourceRowNumber}, ${column.header}`);
      rawPayload[column.header] = value;
      source[column.field] = value;
    }
    rows.push({
      sourceTab: tab,
      sourceRowNumber,
      reportedDateRaw: source.reportedDateRaw ?? "",
      declaredMonth: source.declaredMonth ?? null,
      declaredYear: source.declaredYear ?? null,
      amountUsdRaw: source.amountUsdRaw ?? null,
      customerNameRaw: source.customerNameRaw ?? null,
      customerEmailRaw: source.customerEmailRaw ?? null,
      customerPhoneRaw: source.customerPhoneRaw ?? null,
      categoryRaw: source.categoryRaw ?? null,
      membershipTypeRaw: source.membershipTypeRaw ?? null,
      paymentMethodRaw: source.paymentMethodRaw ?? null,
      paymentStatusRaw: source.paymentStatusRaw ?? null,
      noteRaw: source.noteRaw ?? null,
      rawPayload,
    });
  }
  return rows;
}

/** Parses only the approved Finance workbook tabs. It never evaluates formulas or publishes revenue. */
export async function parsePaymentTrackerWorkbook(sourceFileName: string, bytes: Uint8Array): Promise<ParsedPaymentTrackerWorkbook> {
  validateFile(sourceFileName, bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  } catch {
    throw new PaymentTrackerWorkbookError("The selected file is not a valid XLSX workbook.");
  }
  const worksheets = new Map<AcceptedTab, ExcelJS.Worksheet>();
  for (const tab of acceptedTabs) {
    const worksheet = approvedWorksheet(workbook, tab);
    if (!worksheet) throw new PaymentTrackerWorkbookError(`The Payment Tracker is missing the required ${tab} tab.`);
    worksheets.set(tab, worksheet);
  }
  const rows = acceptedTabs.flatMap((tab) => extractRows(worksheets.get(tab)!, tab));
  if (rows.length === 0) throw new PaymentTrackerWorkbookError("The Payment Tracker has no Finance rows to stage.");
  if (rows.length > MAX_EXTRACTED_ROWS) throw new PaymentTrackerWorkbookError("The Payment Tracker exceeds the maximum of 20,000 extracted Finance rows.");

  return {
    sourceFileName: sourceFileName.trim(),
    sourceFileSha256: createHash("sha256").update(bytes).digest("hex"),
    acceptedTabs: ["B2C", "B2C Cons"],
    rows,
  };
}
