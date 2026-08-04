import type { StripeConfig } from "@/lib/integrations/stripe/config";

type StripeListResponse = { data?: unknown[]; has_more?: boolean };

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

  private async listSince(resource: "charges" | "refunds", since: Date): Promise<unknown[]> {
    const records: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ "created[gte]": String(Math.floor(since.getTime() / 1000)), limit: "100" });
      if (cursor) query.set("starting_after", cursor);
      const response = await this.request(`/v1/${resource}?${query.toString()}`) as StripeListResponse;
      const page = response.data ?? [];
      records.push(...page);
      const last = page.at(-1) as { id?: unknown } | undefined;
      cursor = response.has_more && typeof last?.id === "string" ? last.id : null;
      if (response.has_more && !cursor) throw new Error(`Stripe ${resource} response cannot be paginated safely.`);
    } while (cursor);
    return records;
  }
}
