import {
  type HubSpotConfig,
  requestedHubSpotDealProperties,
} from "@/lib/integrations/hubspot/config";

type HubSpotSearchResponse = {
  results: unknown[];
  paging?: { next?: { after?: string } };
};

type HubSpotCompany = {
  id: string;
  legalName: string;
  domain: string | null;
};

const BACKFILL_PAGE_SIZE = 50;
const HYDRATION_CONCURRENCY = 8;

async function mapWithConcurrency<TInput, TResult>(
  inputs: TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(inputs.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(inputs[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return results;
}

export type HubSpotDealWithCompany = {
  deal: unknown;
  company: HubSpotCompany;
  ownerName: string | null;
};

async function safeErrorLabel(response: Response): Promise<string> {
  const fallback = `HubSpot API request failed (${response.status} ${response.statusText}).`;
  try {
    const payload = await response.json() as { message?: unknown; category?: unknown; correlationId?: unknown };
    const message = typeof payload.message === "string" ? payload.message.slice(0, 300) : null;
    const category = typeof payload.category === "string" ? payload.category.slice(0, 80) : null;
    const correlationId = typeof payload.correlationId === "string" ? payload.correlationId.slice(0, 100) : null;
    if (!message) return fallback;
    return `${fallback} ${message}${category ? ` [${category}]` : ""}${correlationId ? ` (correlation ${correlationId})` : ""}`;
  } catch {
    return fallback;
  }
}

/** HubSpot HTTP access stays provider-specific and never reaches UI code. */
export class HubSpotClient {
  private readonly properties: string[];

  constructor(private readonly config: HubSpotConfig) {
    this.properties = requestedHubSpotDealProperties(config.fieldMapping);
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.privateAppToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await safeErrorLabel(response));
    return response;
  }

  async fetchDealWithCompany(dealId: string): Promise<HubSpotDealWithCompany> {
    const deal = await (await this.request(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(this.properties.join(","))}&propertiesWithHistory=${encodeURIComponent(this.config.fieldMapping.stage)}`,
    )).json();
    const associations = await (await this.request(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/companies`,
    )).json() as { results?: Array<{ id?: string }> };
    const companyId = associations.results?.[0]?.id;

    // A HubSpot deal can lack a company. Keep it traceable under a deterministic company record.
    const company = companyId
      ? await this.fetchCompany(companyId)
      : { id: `unassociated-deal-${dealId}`, legalName: `Unassociated HubSpot deal ${dealId}`, domain: null };

    const properties = (deal as { properties?: Record<string, string | null> }).properties ?? {};
    const ownerId = this.config.fieldMapping.ownerId ? properties[this.config.fieldMapping.ownerId] : null;
    const ownerName = ownerId ? await this.fetchOwnerName(ownerId) : null;
    return { deal, company, ownerName };
  }

  async searchDealsModifiedSince(since: Date): Promise<HubSpotDealWithCompany[]> {
    const deals: HubSpotDealWithCompany[] = [];
    let after: string | undefined;
    do {
      const page = await this.searchB2bDealPage(after, [{ propertyName: this.config.fieldMapping.lastModifiedAt ?? "hs_lastmodifieddate", operator: "GTE", value: String(since.getTime()) }], 100);
      deals.push(...page.deals);
      after = page.nextCursor ?? undefined;
    } while (after);
    return deals;
  }

  /** Reads one bounded page from the approved B2B pipeline for resumable history imports. */
  async searchAllB2bDealsPage(cursor?: string): Promise<{ deals: HubSpotDealWithCompany[]; nextCursor: string | null }> {
    return this.searchB2bDealPage(cursor, [], BACKFILL_PAGE_SIZE);
  }

  private async searchB2bDealPage(
    after: string | undefined,
    filters: Array<{ propertyName: string; operator: "EQ" | "GTE"; value: string }>,
    limit: number,
  ): Promise<{ deals: HubSpotDealWithCompany[]; nextCursor: string | null }> {
    const response = await this.request("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [
          ...filters,
          { propertyName: this.config.fieldMapping.pipeline, operator: "EQ", value: this.config.b2bPipelineId },
        ] }],
        properties: this.properties,
        propertiesWithHistory: [this.config.fieldMapping.stage],
        limit,
        ...(after ? { after } : {}),
      }),
    });
    const page = await response.json() as HubSpotSearchResponse;
    const dealIds = page.results.map((record) => {
      const dealId = (record as { id?: unknown }).id;
      if (typeof dealId !== "string" || !dealId) throw new Error("HubSpot search returned a deal without an ID.");
      return dealId;
    });
    return {
      // Bound parallel provider calls to avoid rate-limit bursts during a large history import.
      deals: await mapWithConcurrency(dealIds, HYDRATION_CONCURRENCY, (dealId) => this.fetchDealWithCompany(dealId)),
      nextCursor: page.paging?.next?.after ?? null,
    };
  }

  private async fetchCompany(companyId: string): Promise<HubSpotCompany> {
    const result = await (await this.request(
      `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=name,domain`,
    )).json() as { id?: unknown; properties?: { name?: unknown; domain?: unknown } };
    const legalName = typeof result.properties?.name === "string" && result.properties.name.trim()
      ? result.properties.name.trim()
      : `HubSpot company ${companyId}`;
    return {
      id: typeof result.id === "string" && result.id ? result.id : companyId,
      legalName,
      domain: typeof result.properties?.domain === "string" && result.properties.domain.trim()
        ? result.properties.domain.trim()
        : null,
    };
  }

  private async fetchOwnerName(ownerId: string): Promise<string | null> {
    const owner = await (await this.request(`/crm/v3/owners/${encodeURIComponent(ownerId)}`)).json() as {
      firstName?: unknown;
      lastName?: unknown;
    };
    const name = [owner.firstName, owner.lastName]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join(" ")
      .trim();
    return name || null;
  }
}
