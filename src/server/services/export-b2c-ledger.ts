import type { B2cDecoratedLedgerRow } from "@/server/repositories/b2c-ledger-repository";

const CSV_HEADERS = ["Customer", "Email", "Mobile", "Date", "Amount", "Source", "Status"];

/** Prevents spreadsheet formula execution while preserving the displayed cell value. */
function safeSpreadsheetValue(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | null): string {
  const safe = safeSpreadsheetValue(value ?? "");
  return `"${safe.replaceAll('"', '""')}"`;
}

function visibleStatus(row: B2cDecoratedLedgerRow): string {
  return row.issue ? `${row.paymentStatus}; ${row.issue}` : row.paymentStatus;
}

/** Exports only the fields already visible in the Ledger table; provider evidence is deliberately excluded. */
export function buildB2cLedgerCsv(rows: B2cDecoratedLedgerRow[]): string {
  const lines = [CSV_HEADERS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.customerName,
      row.customerEmail,
      row.customerPhone,
      row.date,
      row.amountUsd,
      row.source,
      visibleStatus(row),
    ].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
