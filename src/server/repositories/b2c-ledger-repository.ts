import { resolveB2cPaymentDecision, type B2cPaymentDecision } from "@/lib/b2c/payment-decision";
import { getB2cDashboardSnapshot, type B2cLedgerRow, type B2cOpenReviewFlag } from "@/server/repositories/b2c-dashboard-repository";
import type { DatabaseClient } from "@/lib/supabase/server";

export type B2cDecoratedLedgerRow = B2cLedgerRow & { decision: B2cPaymentDecision };

export const B2C_LEDGER_MAX_LIMIT = 100;
export const B2C_LEDGER_DEFAULT_LIMIT = 25;

export type B2cLedgerSort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

export type B2cLedgerQuery = {
  cursor?: string;
  limit?: number;
  period?: string;
  source?: B2cLedgerRow["sourceSystem"];
  sourceStatus?: "succeeded" | "failed" | "pending";
  reportingDecision?: B2cPaymentDecision["reportingDecision"];
  issue?: NonNullable<B2cLedgerRow["issue"]>;
  currency?: string;
  minAmountUsd?: string;
  maxAmountUsd?: string;
  sort?: B2cLedgerSort;
  search?: string;
};

export type B2cLedgerPage = {
  rows: B2cDecoratedLedgerRow[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
};

/** The single open-flag label that maps back into a raw gate flag type. Refund/Tap-only labels are never gate inputs. */
const OPEN_FLAG_LABEL_TO_TYPE: Partial<Record<NonNullable<B2cOpenReviewFlag["type"]>, string>> = {
  "Possible duplicate": "possible_duplicate",
  "Unmapped product": "unmapped_product",
  "Needs follow-up": "needs_follow_up",
  "Missing customer email": "needs_follow_up",
};

function paymentStatusForDecision(row: B2cLedgerRow): "succeeded" | "failed" | "pending" {
  if (row.paymentStatus === "Failed") return "failed";
  if (row.paymentStatus === "Pending" || row.paymentStatus === "Not matched") return "pending";
  return "succeeded";
}

/**
 * Rebuilds the one accurate decision for an already-projected ledger row.
 * Every input comes from a field the row already carries -- no new database
 * read, and no rule loosened beyond what `resolveB2cPaymentDecision` allows.
 */
export function decorateB2cLedgerRow(row: B2cLedgerRow, today = new Date()): B2cDecoratedLedgerRow {
  const openFlagTypes = new Set(row.openReviewFlags.flatMap((flag) => {
    const rawType = OPEN_FLAG_LABEL_TO_TYPE[flag.type];
    return rawType ? [rawType] : [];
  }));
  const decision = resolveB2cPaymentDecision({
    sourceSystem: row.sourceSystem,
    paymentStatus: paymentStatusForDecision(row),
    customerEmail: row.customerEmail,
    categoryCode: row.category === "Unmapped" ? "unmapped" : row.category,
    occurredOn: row.dateValue || null,
    openFlagTypes,
    originalCurrency: row.sourceOriginalCurrency ?? "USD",
    amountUsd: row.amountValueUsd,
    hasFinanceException: row.hasFinanceException,
    isApprovedFinancePayment: row.sourceSystem === "finance_tracker",
    evidenceMatchState: row.tapStatementUnmatched ? "unmatched" : "not_required",
    financeLineageStatus: row.sourceSystem === "finance_tracker" ? "posted" : "not_applicable",
  }, today);
  return { ...row, decision };
}

function matchesQuery(row: B2cDecoratedLedgerRow, query: B2cLedgerQuery): boolean {
  if (query.source && row.sourceSystem !== query.source) return false;
  if (query.sourceStatus && row.decision.sourceStatus !== query.sourceStatus) return false;
  if (query.reportingDecision && row.decision.reportingDecision !== query.reportingDecision) return false;
  if (query.issue && row.issue !== query.issue) return false;
  if (query.currency && (row.sourceOriginalCurrency ?? "USD") !== query.currency) return false;
  if (query.minAmountUsd && (row.amountValueUsd === null || Number(row.amountValueUsd) < Number(query.minAmountUsd))) return false;
  if (query.maxAmountUsd && (row.amountValueUsd === null || Number(row.amountValueUsd) > Number(query.maxAmountUsd))) return false;
  if (query.search) {
    const needle = query.search.trim().toLowerCase();
    if (!needle) return true;
    const haystack = [row.customerName, row.customerEmail, row.providerReference, row.category].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function sortRows(rows: B2cDecoratedLedgerRow[], sort: B2cLedgerSort): B2cDecoratedLedgerRow[] {
  const sorted = [...rows];
  const amount = (row: B2cDecoratedLedgerRow) => Number(row.amountValueUsd ?? "0");
  if (sort === "date_asc") sorted.sort((first, second) => first.dateValue.localeCompare(second.dateValue));
  else if (sort === "amount_desc") sorted.sort((first, second) => amount(second) - amount(first));
  else if (sort === "amount_asc") sorted.sort((first, second) => amount(first) - amount(second));
  else sorted.sort((first, second) => second.dateValue.localeCompare(first.dateValue));
  return sorted;
}

/** A pure, in-memory page over an already-fetched, already-decorated row set. Cursor is an opaque row-index token. */
export function pageB2cLedgerRows(rows: B2cDecoratedLedgerRow[], query: B2cLedgerQuery): B2cLedgerPage {
  const limit = Math.min(Math.max(query.limit ?? B2C_LEDGER_DEFAULT_LIMIT, 1), B2C_LEDGER_MAX_LIMIT);
  const filtered = sortRows(rows.filter((row) => matchesQuery(row, query)), query.sort ?? "date_desc");
  const start = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
  const page = filtered.slice(start, start + limit);
  const nextIndex = start + page.length;
  const hasMore = nextIndex < filtered.length;
  return { rows: page, nextCursor: hasMore ? String(nextIndex) : null, hasMore, totalCount: filtered.length };
}

/** Loads and pages the B2C ledger. Reuses the existing dashboard snapshot for period scoping and every source read. */
export class SupabaseB2cLedgerRepository {
  constructor(private readonly client: DatabaseClient) {}

  async page(query: B2cLedgerQuery, today = new Date()): Promise<B2cLedgerPage> {
    const snapshot = await getB2cDashboardSnapshot(this.client, today, query.period);
    return pageB2cLedgerRows(snapshot.rows.map((row) => decorateB2cLedgerRow(row, today)), query);
  }
}
