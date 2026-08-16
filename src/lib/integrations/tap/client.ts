import type { TapConfig } from "@/lib/integrations/tap/config";

export type TapPage = { records: unknown[]; nextCursor: string | null };
export type TapDateRange = { from: Date; to: Date };

type TapListResponse = Record<string, unknown>;

function extractRecords(payload: TapListResponse, collection: "charges" | "refunds"): unknown[] {
  const nestedData = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)[collection]
    : payload.data;
  const candidate = payload[collection] ?? nestedData ?? payload.results;
  return Array.isArray(candidate) ? candidate : [];
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { errors?: Array<{ description?: unknown }>; message?: unknown };
    const detail = typeof body.message === "string" ? body.message : typeof body.errors?.[0]?.description === "string" ? body.errors[0].description : null;
    return detail ? `Tap API request failed (${response.status}). ${detail.slice(0, 300)}` : `Tap API request failed (${response.status}).`;
  } catch { return `Tap API request failed (${response.status}).`; }
}

/**
 * Explicit read-only Tap boundary. List endpoints use POST only to submit a
 * search query; this client cannot create, modify, refund, or delete Tap data.
 */
export class TapClient {
  constructor(private readonly config: TapConfig) {}

  private async get(path: `/v2/charges/${string}`): Promise<unknown> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await safeErrorMessage(response));
    return response.json();
  }

  private async list(path: "/v2/charges/list" | "/v2/refunds/list", body: Record<string, unknown>): Promise<TapListResponse> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await safeErrorMessage(response));
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Tap API returned an invalid list response.");
    return payload as TapListResponse;
  }

  async fetchCharge(chargeId: string): Promise<unknown> {
    return this.get(`/v2/charges/${encodeURIComponent(chargeId)}`);
  }

  async listChargesCreatedSince(since: Date): Promise<unknown[]> { return this.listSince("charges", since); }
  async listRefundsCreatedSince(since: Date): Promise<unknown[]> { return this.listSince("refunds", since); }
  async listChargesPage(range: TapDateRange, cursor?: string): Promise<TapPage> { return this.listPage("charges", range, cursor); }
  async listRefundsPage(range: TapDateRange, cursor?: string): Promise<TapPage> { return this.listPage("refunds", range, cursor); }

  private async listSince(collection: "charges" | "refunds", since: Date): Promise<unknown[]> {
    const records: unknown[] = [];
    let cursor: string | undefined;
    let reachedOlderRecord = false;
    const range = { from: since, to: new Date() };
    while (!reachedOlderRecord) {
      const page = await this.listPage(collection, range, cursor);
      if (!page.records.length) break;
      for (const record of page.records) {
        const createdAt = tapRecordCreatedAt(record);
        if (createdAt && createdAt >= since) records.push(record);
        else reachedOlderRecord = true;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return records;
  }

  private async listPage(collection: "charges" | "refunds", range: TapDateRange, cursor?: string): Promise<TapPage> {
    const path = collection === "charges" ? "/v2/charges/list" : "/v2/refunds/list";
    const period = tapPeriod(range);
    // Charges support an explicit sort order. Refunds are documented as
    // reverse-chronological already and do not accept the `order` parameter.
    let response: TapListResponse;
    try {
      response = await this.list(path, {
        period,
        limit: 50,
        ...(collection === "charges" ? { order: "reverse_chronological" } : {}),
        ...(cursor ? { starting_after: cursor } : {}),
      });
    } catch (error) {
      // Tap returns HTTP 400 "Charges/Refunds not found" for a selected
      // period without matching records. That is an empty source window,
      // not an import failure.
      if (error instanceof Error && new RegExp(`Tap API request failed \\(400\\)\\. ${collection === "charges" ? "Charges" : "Refunds"} not found\\.?$`, "i").test(error.message)) {
        return { records: [], nextCursor: null };
      }
      throw error;
    }
    const records = extractRecords(response, collection);
    const last = records.at(-1) as { id?: unknown } | undefined;
    // Tap's documented maximum page size is 50. A full page may have another
    // page; an empty/short page cannot safely claim a continuation.
    if (records.length < 50) return { records, nextCursor: null };
    if (typeof last?.id !== "string") throw new Error(`Tap ${collection} response cannot be paginated safely.`);
    return { records, nextCursor: last.id };
  }
}

function tapPeriod(range: TapDateRange): { date: { from: string; to: string }; type: "1" } {
  const from = range.from.getTime();
  const to = range.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("Tap read period is invalid.");
  return { date: { from: String(from), to: String(to) }, type: "1" };
}

function tapRecordCreatedAt(record: unknown): Date | null {
  if (!record || typeof record !== "object") return null;
  const source = record as { created?: unknown; transaction?: { created?: unknown } };
  const raw = source.transaction?.created ?? source.created;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const milliseconds = Number.isFinite(numeric) ? (numeric > 10_000_000_000 ? numeric : numeric * 1000) : Date.parse(typeof raw === "string" ? raw : "");
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}
