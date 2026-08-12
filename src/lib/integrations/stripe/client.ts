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
    // Keep the provider boundary explicit: this client is incapable of sending
    // a Stripe write request because every call is an explicit HTTP GET.
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, { method: "GET", headers: { Authorization: `Bearer ${this.config.apiKey}` }, cache: "no-store" });
    if (!response.ok) throw new Error(await safeErrorMessage(response));
    return response.json();
  }

  async fetchCharge(chargeId: string): Promise<unknown> { return this.request(`/v1/charges/${encodeURIComponent(chargeId)}`); }
  async fetchPaymentMethod(paymentMethodId: string): Promise<unknown> { return this.request(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`); }
  async fetchCustomer(customerId: string): Promise<unknown> { return this.request(`/v1/customers/${encodeURIComponent(customerId)}`); }
  async fetchInvoice(invoiceId: string): Promise<unknown> {
    const query = new URLSearchParams();
    query.append("expand[]", "lines.data.price.product");
    return this.request(`/v1/invoices/${encodeURIComponent(invoiceId)}?${query.toString()}`);
  }
  async fetchBalanceTransaction(balanceTransactionId: string): Promise<unknown> { return this.request(`/v1/balance_transactions/${encodeURIComponent(balanceTransactionId)}`); }
  /**
   * Checkout is the reliable path from a Charge's PaymentIntent to its Price
   * and Product. The result remains untrusted until normalised by the service.
   */
  async fetchCheckoutPlanForPaymentIntent(paymentIntentId: string): Promise<unknown | null> {
    const context = await this.fetchCheckoutContextForPaymentIntent(paymentIntentId) as { session: { id: string }; lineItems: unknown } | null;
    return context ? { sessionId: context.session.id, lineItems: context.lineItems } : null;
  }
  async fetchCheckoutContextForPaymentIntent(paymentIntentId: string): Promise<unknown | null> {
    const query = new URLSearchParams({ payment_intent: paymentIntentId, limit: "1" });
    const sessions = await this.request(`/v1/checkout/sessions?${query.toString()}`) as StripeListResponse;
    const session = sessions.data?.[0] as { id?: unknown } | undefined;
    if (typeof session?.id !== "string") return null;
    const lineItemQuery = new URLSearchParams({ limit: "100" });
    lineItemQuery.append("expand[]", "data.price.product");
    const lineItems = await this.request(`/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?${lineItemQuery.toString()}`);
    return { session, lineItems };
  }
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
