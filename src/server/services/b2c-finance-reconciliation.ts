import {
  financeWorkbookRowSchema,
  tapEvidenceRowSchema,
  type FinanceWorkbookRowInput,
  type TapEvidenceRowInput,
} from "@/lib/validation/b2c-finance-import-contracts";

export type FinanceRowQuality = "valid" | "zero_value" | "needs_review" | "invalid";
export type FinanceComparison = "unmatched" | "exact_duplicate_candidate" | "possible_duplicate" | "conflict";
export type TapEvidenceKind = "sale" | "processing_fee" | "fee_vat" | "refund" | "transfer" | "opening_balance" | "needs_review";

export type AssessedFinanceRow = {
  sourceTab: "B2C" | "B2C Cons";
  sourceRowNumber: number;
  occurredOn: string | null;
  amountUsd: string | null;
  normalizedCustomerName: string | null;
  normalizedCustomerEmail: string | null;
  normalizedPaymentMethod: string | null;
  quality: FinanceRowQuality;
  issues: string[];
};

export type ClassifiedTapEvidence = {
  kind: TapEvidenceKind;
  issue: string | null;
  isReportableRevenue: false;
};

const decimalPattern = /^\d+(?:\.\d{1,6})?$/;
const monthNumbers: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9,
  sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function normalizeText(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US") : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = normalizeText(value);
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function parseDecimal(rawValue: string | null | undefined): string | null {
  const value = cleanText(rawValue);
  if (!value || !decimalPattern.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function decimalIsZero(value: string): boolean {
  return /^0(?:\.0+)?$/.test(value);
}

function calendarDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Parses only an ISO date, an unambiguous dd/mm/yyyy value, or an Excel serial date. */
function parseFinanceDate(rawValue: string): string | null {
  const value = cleanText(rawValue);
  if (!value) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (dmy && Number(dmy[1]) > 12) return calendarDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  if (/^\d{1,5}(?:\.\d+)?$/.test(value)) {
    const serial = Number(value);
    if (Number.isFinite(serial) && serial >= 1 && serial <= 100_000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
      return date.toISOString().slice(0, 10);
    }
  }
  return null;
}

function monthFromIsoDate(value: string): number {
  return Number(value.slice(5, 7));
}

function yearFromIsoDate(value: string): number {
  return Number(value.slice(0, 4));
}

function daysApart(left: string, right: string): number {
  return Math.abs((Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`)) / 86_400_000);
}

/** Assesses raw Finance data without repairing its source text or publishing a financial value. */
export function assessFinanceRow(input: FinanceWorkbookRowInput): AssessedFinanceRow {
  const row = financeWorkbookRowSchema.parse(input);
  const issues: string[] = [];
  const occurredOn = parseFinanceDate(row.reportedDateRaw);
  const amountUsd = parseDecimal(row.amountUsdRaw);
  const declaredMonth = normalizeText(row.declaredMonth);
  const declaredYear = cleanText(row.declaredYear);

  if (!occurredOn) issues.push("unparseable_date");
  if (!amountUsd) issues.push(cleanText(row.amountUsdRaw) ? "invalid_amount" : "missing_amount");
  if (!cleanText(row.customerNameRaw)) issues.push("missing_customer_name");
  if (!cleanText(row.paymentMethodRaw)) issues.push("missing_payment_method");

  if (occurredOn && declaredMonth && monthNumbers[declaredMonth] && monthNumbers[declaredMonth] !== monthFromIsoDate(occurredOn)) {
    issues.push("declared_month_conflicts_with_date");
  }
  if (occurredOn && declaredYear && /^\d{4}$/.test(declaredYear) && Number(declaredYear) !== yearFromIsoDate(occurredOn)) {
    issues.push("declared_year_conflicts_with_date");
  }

  const quality: FinanceRowQuality = amountUsd && decimalIsZero(amountUsd)
    ? "zero_value"
    : issues.includes("invalid_amount")
      ? "invalid"
      : issues.length > 0
        ? "needs_review"
        : "valid";

  return {
    sourceTab: row.sourceTab,
    sourceRowNumber: row.sourceRowNumber,
    occurredOn,
    amountUsd,
    normalizedCustomerName: normalizeText(row.customerNameRaw),
    normalizedCustomerEmail: normalizeEmail(row.customerEmailRaw),
    normalizedPaymentMethod: normalizeText(row.paymentMethodRaw),
    quality,
    issues,
  };
}

function sameIdentity(left: AssessedFinanceRow, right: AssessedFinanceRow): boolean {
  if (left.normalizedCustomerEmail && right.normalizedCustomerEmail) {
    return left.normalizedCustomerEmail === right.normalizedCustomerEmail;
  }
  return Boolean(left.normalizedCustomerName && right.normalizedCustomerName
    && left.normalizedCustomerName === right.normalizedCustomerName);
}

/** Proposes review states only; it never merges, excludes, or publishes a row. */
export function compareFinanceRows(left: AssessedFinanceRow, right: AssessedFinanceRow): FinanceComparison {
  if (left.quality !== "valid" || right.quality !== "valid" || !sameIdentity(left, right)
    || !left.occurredOn || !right.occurredOn || !left.amountUsd || !right.amountUsd
    || !left.normalizedPaymentMethod || !right.normalizedPaymentMethod) return "unmatched";

  const sameAmount = left.amountUsd === right.amountUsd;
  const sameMethod = left.normalizedPaymentMethod === right.normalizedPaymentMethod;
  if (left.occurredOn === right.occurredOn) {
    if (sameAmount && sameMethod) return "exact_duplicate_candidate";
    return "conflict";
  }
  if (sameAmount && sameMethod && daysApart(left.occurredOn, right.occurredOn) <= 3) return "possible_duplicate";
  return "unmatched";
}

/** Classifies Tap statement lines as payment evidence without converting their currency or creating sales. */
export function classifyTapEvidence(input: TapEvidenceRowInput): ClassifiedTapEvidence {
  const row = tapEvidenceRowSchema.parse(input);
  const description = cleanText(row.description)?.toLocaleLowerCase("en-US") ?? "";
  const chargeId = cleanText(row.chargeId);
  const refundId = cleanText(row.refundId);

  if (refundId) return { kind: "refund", issue: null, isReportableRevenue: false };
  if (description.startsWith("sale -")) {
    return chargeId
      ? { kind: "sale", issue: null, isReportableRevenue: false }
      : { kind: "needs_review", issue: "sale_missing_charge_id", isReportableRevenue: false };
  }
  if (description.startsWith("fee - transaction processing")) return { kind: "processing_fee", issue: null, isReportableRevenue: false };
  if (description.startsWith("vat - transaction processing")) return { kind: "fee_vat", issue: null, isReportableRevenue: false };
  if (description.startsWith("transfer -")) return { kind: "transfer", issue: null, isReportableRevenue: false };
  if (description === "opening balance") return { kind: "opening_balance", issue: null, isReportableRevenue: false };
  return { kind: "needs_review", issue: "unrecognised_tap_statement_line", isReportableRevenue: false };
}
