import type { StripeConfig } from "@/lib/integrations/stripe/config";

type StripeListResponse = { data?: unknown[]; has_more?: boolean };
export type StripePage = { records: unknown[]; nextCursor: string | null };

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown; type?: unknown } };
    const message = typeof body.error?.message === "string" ? body.error.message.slice(0, 300) : null;
    const type = typeof body.error?.type === "string" ? body.error.type.slice(0, 80) : null;
    return message ? `Stripe API request failed (${response.status}). ${message}${type ? ` [${type}]` : ""}` : `Stripe API request failed (${response.status}).`;
  } catch { return `Stripe API request failed (${response.status}).`; }
}

/** Read-only Stripe API access. No method in this client can create, edit, or delete Stripe data. */
export class StripeClient {
  constructor(private readonly config: StripeConfig) {}

  private async request(path: string): Promise<unknown> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${this.config.apiKey}` }, cache: "no-store" });
    if (!response.ok) throw new Error(await safeErrorMessage(response));
    return response.json();
  }

  async fetchCharge(chargeId: string): Promise<unknown> { return this.request(`/v1/charges/${encodeURIComponent(chargeId)}`); }
  async listChargesCreatedSince(since: Date): Promise<unknown[]> { return this.listSince("charges", since); }
  async listRefundsCreatedSince(since: Date): Promise<unknown[]> { return this.listSince("refunds", since); }
  async listChargesPage(cursor?: string): Promise<StripePage> { return this.listPage("charges", cursor); }
  async listRefundsPage(cursor?: string): Promise<StripePage> { return this.listPage("refunds", cursor); }

  private async listSince(resource: "charges" | "refunds", since: Date): Promise<unknown[]> {
    const records: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listPage(resource, cursor ?? undefined, since);
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    return records;
  }

  private async listPage(resource: "charges" | "refunds", cursor?: string, since?: Date): Promise<StripePage> {
    const query = new URLSearchParams({ limit: "100" });
    if (since) query.set("created[gte]", String(Math.floor(since.getTime() / 1000)));
    if (cursor) query.set("starting_after", cursor);
    const response = await this.request(`/v1/${resource}?${query.toString()}`) as StripeListResponse;
    const records = response.data ?? [];
    const last = records.at(-1) as { id?: unknown } | undefined;
    if (!response.has_more) return { records, nextCursor: null };
    if (typeof last?.id !== "string") throw new Error(`Stripe ${resource} response cannot be paginated safely.`);
    return { records, nextCursor: last.id };
  }
}
