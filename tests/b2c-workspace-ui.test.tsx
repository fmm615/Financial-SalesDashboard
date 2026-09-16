import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cWorkspace } from "@/features/b2c/b2c-workspace";
import { RoleProvider } from "@/lib/auth/role-context";
import type { B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";
import type { B2cSafeLedgerRow } from "@/features/b2c/b2c-ledger-table";

let currentSearch = new URLSearchParams();
const pushMock = vi.fn();
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations/b2c",
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => currentSearch,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  pushMock.mockClear();
  replaceMock.mockClear();
  currentSearch = new URLSearchParams();
});

const snapshot: B2cDashboardSnapshot = {
  period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
  sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-19T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
  hasSourceRecords: true, eligiblePaymentsUsd: "$150.00", refundsUsd: "$10.00", netPaymentsUsd: "$140.00", completedSourcePaymentsUsd: "$160.00", sourceRefundsUsd: "$10.00",
  calculation: { completedSourcePaymentCount: 2, reportablePaymentCount: 2, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 1, eligibleRefundCount: 1, missingCustomerEmailCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
  reviewItems: 2, rows: [],
};

const ledgerRow: B2cSafeLedgerRow = {
  id: "payment-1", recordType: "Payment" as const, customerName: "Maya Al Khalifa", customerEmail: "maya@example.com", customerPhone: null,
  customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
  date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$100.00", amountValueUsd: "100", sourceAmountUsd: "$100.00", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-09",
  membershipTier: "Monthly", billingInterval: "Monthly", source: "Stripe", paymentStatus: "Completed" as const,
  providerReference: "ch_123", sourceSystem: "stripe" as const, productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
  hasOpenPaymentDuplicate: false, hasDuplicateExclusion: false,
  openReviewFlags: [], issue: null,
  decision: { sourceStatus: "succeeded" as const, reconciliationStatus: "not_required" as const, reportingDecision: "reportable" as const, postingStatus: "not_applicable" as const, blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
};

const workItems = {
  items: [
    { id: "payment-2:missing_amount", recordId: "payment-2", recordKind: "provider_payment" as const, queue: "data_quality" as const, visibleGroup: "data" as const, financeMethod: null, title: "Enter the missing amount for Sam", explanation: "This record has no available USD amount.", financialImpactUsd: null, nextAction: "correct" as const, href: "/operations/b2c?tab=work&record=payment-2" },
    { id: "payment-3:possible_duplicate", recordId: "payment-3", recordKind: "provider_payment" as const, queue: "duplicate" as const, visibleGroup: "duplicates" as const, financeMethod: null, title: "Choose the duplicate for Noor", explanation: "This record has an unresolved possible duplicate.", financialImpactUsd: "$40.00", nextAction: "choose_payment_duplicate" as const, href: "/operations/b2c?tab=work&record=payment-3" },
    { id: "run-1:source_failure", recordId: "run-1", recordKind: "source_run" as const, queue: "source_failure" as const, visibleGroup: "reconciliation" as const, financeMethod: null, title: "Retry the Stripe sync", explanation: "The last Stripe sync failed. Retry it from Sources.", financialImpactUsd: null, nextAction: "retry_source" as const, href: "/operations/b2c?tab=sources&provider=stripe" },
  ],
  counts: { all: 3, data: 1, duplicates: 1, reconciliation: 1 },
};

const emptyWorkItems = {
  items: [],
  counts: { all: 0, data: 0, duplicates: 0, reconciliation: 0 },
};

function filterMetadataForRows(rows: B2cSafeLedgerRow[]) {
  return {
    sources: [...new Set(rows.map((row) => row.source))].sort(),
    issues: [...new Set(rows.flatMap((row) => row.issue ? [row.issue] : []))].sort(),
    foreignCurrencyCount: rows.filter((row) => row.foreignCurrencyReview).length,
  };
}

function stubFetch(overrides: { role?: "admin" | "viewer"; ledgerRows?: B2cSafeLedgerRow[]; overview?: typeof workItems } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/b2c/workspace")) {
      const role = overrides.role ?? "admin";
      const rows = overrides.ledgerRows ?? [ledgerRow];
      return { ok: true, json: async () => ({ role, ledger: { rows, nextCursor: null, hasMore: false, totalCount: rows.length, filterMetadata: filterMetadataForRows(rows) }, workItems: role === "admin" ? (overrides.overview ?? workItems) : null }) };
    }
    return { ok: false, json: async () => ({ error: "unexpected" }) };
  }));
}

describe("B2cWorkspace tab defaults and URL state", () => {
  it("defaults an Admin to the Ledger", async () => {
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const tablist = await screen.findByRole("tablist", { name: "B2C workspace" });
    expect(within(tablist).getByRole("tab", { name: "Ledger", selected: true })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "B2C ledger" })).toBeInTheDocument();
  });

  it("defaults a Viewer to the Ledger and never offers the Work queue tab", async () => {
    stubFetch({ role: "viewer" });
    render(<RoleProvider role="viewer"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const tablist = await screen.findByRole("tablist", { name: "B2C workspace" });
    expect(within(tablist).getByRole("tab", { name: "Ledger", selected: true })).toBeInTheDocument();
    expect(within(tablist).queryByRole("tab", { name: "Work queue" })).not.toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "B2C ledger" })).toBeInTheDocument();
  });

  it("keeps an explicit Admin tab=work request even without a URL default", async () => {
    currentSearch = new URLSearchParams("tab=work");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const tablist = await screen.findByRole("tablist", { name: "B2C workspace" });
    expect(within(tablist).getByRole("tab", { name: "Work queue", selected: true })).toBeInTheDocument();
  });

  it("forces a Viewer requesting tab=work back onto the Ledger", async () => {
    currentSearch = new URLSearchParams("tab=work");
    stubFetch({ role: "viewer" });
    render(<RoleProvider role="viewer"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findByRole("table", { name: "B2C ledger" })).toBeInTheDocument();
  });

  it("opens directly on Sources when the URL requests it", async () => {
    currentSearch = new URLSearchParams("tab=sources");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findByText("Sync Stripe now")).toBeInTheDocument();
  });
});

describe("Work queue", () => {
  it("shows three filter chips with counts and exactly one primary action per item", async () => {
    currentSearch = new URLSearchParams("tab=work");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const chips = await screen.findByRole("group", { name: "Work queue filters" });
    for (const [label, count] of [["All", "3"], ["Data", "1"], ["Duplicates", "1"], ["Reconciliation", "1"]]) {
      expect(within(chips).getByRole("button", { name: new RegExp(`^${label} ${count}$`) })).toBeInTheDocument();
    }

    const dataItem = (await screen.findByText("Enter the missing amount for Sam")).closest("li");
    expect(dataItem).not.toBeNull();
    expect(within(dataItem as HTMLElement).getAllByRole("button")).toHaveLength(1);
    expect(within(dataItem as HTMLElement).getByRole("button", { name: "Correct" })).toBeInTheDocument();
  });

  it("no longer offers a Ready-to-post filter or panel", async () => {
    currentSearch = new URLSearchParams("tab=work");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const chips = await screen.findByRole("group", { name: "Work queue filters" });
    expect(within(chips).queryByRole("button", { name: /Ready to post/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post approved Finance payments" })).not.toBeInTheDocument();
  });

  it("filters to the Duplicates chip", async () => {
    currentSearch = new URLSearchParams("tab=work");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const chips = await screen.findByRole("group", { name: "Work queue filters" });
    fireEvent.click(within(chips).getByRole("button", { name: /^Duplicates 1$/ }));

    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("queue=duplicates"));
  });

  it("removes a resolved payment duplicate immediately and requests a background workspace reload", async () => {
    currentSearch = new URLSearchParams("tab=work&record=payment-3");
    let workspaceRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/b2c/workspace")) {
        workspaceRequests += 1;
        const overview = workspaceRequests === 1 ? workItems : emptyWorkItems;
        const rows = workspaceRequests === 1 ? [{
          ...ledgerRow, id: "payment-3", hasOpenPaymentDuplicate: true, issue: "Possible duplicate" as const,
          decision: { sourceStatus: "succeeded" as const, reconciliationStatus: "duplicate_pending" as const, reportingDecision: "blocked" as const, postingStatus: "not_applicable" as const, blockingReasons: ["possible_duplicate" as const], explanation: "Blocked by an unresolved possible duplicate." },
        }] : [];
        return { ok: true, json: async () => ({ role: "admin", ledger: { rows, nextCursor: null, hasMore: false, totalCount: rows.length, filterMetadata: filterMetadataForRows(rows) }, workItems: overview }) };
      }
      if (url.endsWith("/payments/payment-3/duplicate-group")) return { ok: true, json: async () => ({ kind: "group", group: {
        groupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", detectionReason: "Matching payment facts within the approved window.", members: [
          { paymentId: "payment-3", sourceSystem: "stripe", providerReference: "ch_3", customerName: "Noor", sourceCustomerEmail: "noor@example.com", effectiveCustomerEmail: "noor@example.com", sourceAmount: "40", sourceCurrency: "USD", effectiveAmountUsd: "40", sourceOccurredOn: "2026-08-09", effectiveOccurredOn: "2026-08-09" },
          { paymentId: "payment-4", sourceSystem: "tap", providerReference: "tap_4", customerName: "Noor", sourceCustomerEmail: "noor@example.com", effectiveCustomerEmail: "noor@example.com", sourceAmount: "40", sourceCurrency: "USD", effectiveAmountUsd: "40", sourceOccurredOn: "2026-08-09", effectiveOccurredOn: "2026-08-09" },
        ],
      } }) };
      if (url.includes("/payment-duplicate-groups/") && url.endsWith("/decision") && init?.method === "POST") {
        return { ok: true, json: async () => ({ groupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resolvedPaymentIds: ["payment-3", "payment-4"] }) };
      }
      if (url.includes("/audit-history")) return { ok: true, json: async () => ({ entries: [] }) };
      return { ok: false, json: async () => ({ error: "unexpected" }) };
    }));
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Payment duplicate decision reason"), { target: { value: "Finance verified the provider records are separate payments." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep all payments" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(workspaceRequests).toBeGreaterThanOrEqual(2);
  });
});

describe("Ledger", () => {
  it("renders the reporting period inside the Ledger filter bar and nowhere on Work", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin" });
    const { unmount } = render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const filters = await screen.findByRole("region", { name: "B2C ledger filters" });
    const period = within(filters).getByLabelText("B2C reporting period");
    const search = within(filters).getByPlaceholderText("Name, email, mobile, or ID");
    expect(period.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    unmount();
    currentSearch = new URLSearchParams("tab=work");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);
    await screen.findByText("Enter the missing amount for Sam");
    expect(screen.queryByLabelText("B2C reporting period")).not.toBeInTheDocument();
  });

  it("replaces rows across label-only Previous and Next keyset pages", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    const requestedCursors: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), "https://playbook.test");
      const cursor = url.searchParams.get("cursor");
      requestedCursors.push(cursor);
      const pageNumber = cursor === "page-3" ? 3 : cursor === "page-2" ? 2 : 1;
      const row = { ...ledgerRow, id: `payment-${pageNumber}`, customerName: `Customer page ${pageNumber}` };
      return {
        ok: true,
        json: async () => ({
          role: "admin",
          ledger: {
            rows: [row],
            nextCursor: pageNumber === 1 ? "page-2" : pageNumber === 2 ? "page-3" : null,
            hasMore: pageNumber < 3,
            totalCount: 250,
            filterMetadata: filterMetadataForRows([row]),
          },
          workItems: null,
        }),
      };
    }));
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const pagination = await screen.findByRole("navigation", { name: "B2C Ledger pagination" });
    expect(within(pagination).getByText("Page 1 of 3")).toBeInTheDocument();
    expect(within(pagination).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(pagination).queryByRole("button", { name: "1" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Customer page 1").length).toBeGreaterThan(0);

    fireEvent.click(within(pagination).getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2 of 3");
    expect(screen.getAllByText("Customer page 2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Customer page 1")).not.toBeInTheDocument();

    fireEvent.click(within(pagination).getByRole("button", { name: "Next" }));
    await screen.findByText("Page 3 of 3");
    expect(within(pagination).getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.click(within(pagination).getByRole("button", { name: "Previous" }));
    await screen.findByText("Page 2 of 3");
    expect(requestedCursors).toEqual([null, "page-2", "page-3", "page-2"]);
    expect(vi.mocked(global.fetch).mock.calls.every(([input]) => new URL(String(input), "https://playbook.test").searchParams.get("includeWorkItems") === "false")).toBe(true);
  });

  it("does not present retired unmapped-product exclusions or a Ledger filter", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin", ledgerRows: [{ ...ledgerRow, issue: "Needs follow-up" }] });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    fireEvent.click(screen.getByText("Why totals differ"));

    const totalsExplanation = screen.getByText("Why totals differ").parentElement as HTMLElement;
    expect(within(totalsExplanation).queryByText(/unmapped product/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Unmapped product" })).not.toBeInTheDocument();
  });

  it("asks the server to apply a Source filter and renders the returned ledger page unchanged", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    const workspaceUrls: string[] = [];
    const serverReturnedRow: B2cSafeLedgerRow = {
      ...ledgerRow,
      id: "payment-returned-by-server",
      customerName: "Server returned this row",
      customerEmail: "returned@example.com",
      source: "Tap",
      sourceSystem: "tap",
      providerReference: "tap_returned",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes("/api/b2c/workspace")) return { ok: false, json: async () => ({ error: "unexpected" }) };
      workspaceUrls.push(url);
      const source = new URL(url, "https://playbook.test").searchParams.get("source");
      const rows = source === "stripe" ? [serverReturnedRow] : [ledgerRow];
      return { ok: true, json: async () => ({ role: "admin", ledger: { rows, nextCursor: source ? null : "100", hasMore: !source, totalCount: source ? 211 : rows.length, filterMetadata: filterMetadataForRows(rows) }, workItems }) };
    }));
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Stripe" } });

    await waitFor(() => expect(workspaceUrls.some((url) => {
      const params = new URL(url, "https://playbook.test").searchParams;
      return params.get("source") === "stripe" && params.get("cursor") === null;
    })).toBe(true));
    expect((await screen.findAllByText("Server returned this row")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Maya Al Khalifa")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 211 records")).toBeInTheDocument();
  });

  it("keeps filter choices and the FX-review count from server metadata after a narrow page reload", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    const filterMetadata = { sources: ["Stripe", "Tap"], issues: ["Needs follow-up"], foreignCurrencyCount: 3 };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ role: "admin", ledger: { rows: [ledgerRow], nextCursor: null, hasMore: false, totalCount: 1, filterMetadata }, workItems }),
    })));
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Stripe" } });
    await waitFor(() => expect(vi.mocked(global.fetch).mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByRole("option", { name: "Tap" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("More filters"));
    expect(screen.getByRole("option", { name: "Needs follow-up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs FX review (3)" })).toBeEnabled();
  });

  it("sends every remaining Ledger filter to the server", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    const foreignCurrencyRow: B2cSafeLedgerRow = {
      ...ledgerRow,
      sourceOriginalCurrency: "BHD",
      foreignCurrencyReview: true,
    };
    stubFetch({ role: "admin", ledgerRows: [foreignCurrencyRow] });
    const fetchMock = vi.mocked(global.fetch);
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={{ ...snapshot, period: { ...snapshot.period, month: "all", monthLabel: "All time", isAllTime: true } }} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    const expectQuery = async (key: string, value: string) => {
      await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), "https://playbook.test").searchParams.get(key) === value)).toBe(true));
    };

    fireEvent.change(screen.getByPlaceholderText("Name, email, mobile, or ID"), { target: { value: "Maya" } });
    await expectQuery("search", "Maya");
    fireEvent.change(screen.getByLabelText("Payment status"), { target: { value: "Refunded" } });
    await expectQuery("paymentStatus", "Refunded");
    fireEvent.change(screen.getByLabelText("Issue"), { target: { value: "none" } });
    await expectQuery("issue", "none");
    fireEvent.change(screen.getByLabelText("Finance status"), { target: { value: "blocked" } });
    await expectQuery("reportingDecision", "blocked");
    fireEvent.click(screen.getByText("More filters"));
    fireEvent.change(screen.getByLabelText("Date from"), { target: { value: "2026-08-01" } });
    await expectQuery("dateFrom", "2026-08-01");
    fireEvent.change(screen.getByLabelText("Date to"), { target: { value: "2026-08-31" } });
    await expectQuery("dateTo", "2026-08-31");
    fireEvent.change(screen.getByLabelText("Minimum USD"), { target: { value: "10" } });
    await expectQuery("minAmountUsd", "10");
    fireEvent.change(screen.getByLabelText("Maximum USD"), { target: { value: "100" } });
    await expectQuery("maxAmountUsd", "100");
    fireEvent.click(screen.getByRole("button", { name: "Needs FX review (1)" }));
    await expectQuery("foreignCurrencyOnly", "true");
  });

  it("downloads the current Admin filters and explains when the CSV is capped", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    const createObjectUrl = vi.fn(() => "blob:b2c-ledger");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/b2c/workspace/export")) {
        return new Response("Customer,Email", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="b2c-ledger-2026-08.csv"',
            "Content-Type": "text/csv; charset=utf-8",
            "X-Playbook-Export-Capped": "true",
            "X-Playbook-Export-Row-Count": "5000",
          },
        });
      }
      return new Response(JSON.stringify({
        role: "admin",
        ledger: { rows: [ledgerRow], nextCursor: null, hasMore: false, totalCount: 1, filterMetadata: filterMetadataForRows([ledgerRow]) },
        workItems,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const fetchMock = vi.mocked(global.fetch);
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Stripe" } });
    fireEvent.change(screen.getByPlaceholderText("Name, email, mobile, or ID"), { target: { value: "Maya" } });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    const filterRegion = screen.getByRole("region", { name: "B2C ledger filters" });
    expect(await within(filterRegion).findByRole("status")).toHaveTextContent("first 5,000 matching records");
    const exportCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/b2c/workspace/export"));
    expect(exportCall).toBeDefined();
    const exportUrl = new URL(String(exportCall![0]), "https://playbook.test");
    expect(Object.fromEntries(exportUrl.searchParams.entries())).toMatchObject({ period: "2026-08", source: "stripe", search: "Maya" });
    expect(exportUrl.searchParams.has("cursor")).toBe(false);
    expect(exportUrl.searchParams.has("limit")).toBe(false);
    expect(createObjectUrl).toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:b2c-ledger");
  });

  it("shows customer, email, mobile, date, amount, source, description, status, and one Review action", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    expect(within(table).getByRole("columnheader", { name: "Customer" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Email" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Mobile" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Date" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Amount" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Provider ID" })).not.toBeInTheDocument();
    expect(within(table).getByText("maya@example.com")).toBeInTheDocument();

    const row = within(table).getByText("Maya Al Khalifa").closest("tr") as HTMLElement;
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    expect(within(row).getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "View Stripe details" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
  });

  it("shows whether each row currently counts toward Finance totals", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    const blockedRow: B2cSafeLedgerRow = {
      ...ledgerRow, id: "payment-blocked", customerName: "Sam Blocked",
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["missing_amount"], explanation: "Blocked by a missing amount." },
    };
    const exceptionRow: B2cSafeLedgerRow = {
      ...ledgerRow, id: "payment-exception", customerName: "Nora Exception",
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "exception_included", postingStatus: "not_applicable", blockingReasons: [], explanation: "Included by a Finance exception." },
    };
    stubFetch({ role: "admin", ledgerRows: [ledgerRow, blockedRow, exceptionRow] });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    const reportableRow = within(table).getByText("Maya Al Khalifa").closest("tr") as HTMLElement;
    expect(within(reportableRow).getByText("Included in Finance")).toBeInTheDocument();
    const exceptionIncludedRow = within(table).getByText("Nora Exception").closest("tr") as HTMLElement;
    expect(within(exceptionIncludedRow).getByText("Included in Finance")).toBeInTheDocument();
    const blockedRowEl = within(table).getByText("Sam Blocked").closest("tr") as HTMLElement;
    expect(within(blockedRowEl).getByText("Excluded from Finance")).toBeInTheDocument();
  });

  it("shows a provider's decline/seller message beside the description when one is retained", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin", ledgerRows: [{ ...ledgerRow, sourceDescription: "Subscription update", sourceSellerMessage: "Your card was declined: insufficient funds." }] });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    expect(within(table).getByText("Subscription update")).toBeInTheDocument();
    expect(within(table).getByText("Your card was declined: insufficient funds.")).toBeInTheDocument();
  });

  it("renders an unavailable provider description as a dash", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin", ledgerRows: [{ ...ledgerRow, sourceDescription: null }] });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    const row = within(table).getByText("Maya Al Khalifa").closest("tr") as HTMLElement;

    expect(within(row).getAllByRole("cell")[6]).toHaveTextContent("—");
  });

  it("renders an unavailable provider description in the compact mobile card", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin", ledgerRows: [{ ...ledgerRow, sourceDescription: null }] });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    const compactCards = document.querySelector('ul[class~="sm:hidden"]') as HTMLElement;

    expect(compactCards).toBeInTheDocument();
    expect(within(compactCards).getByText("—")).toBeInTheDocument();
  });

  it("shows Search, Source, Status, and Issue as primary filters and hides the rest behind More filters", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);
    await screen.findByRole("table", { name: "B2C ledger" });

    expect(screen.getByPlaceholderText("Name, email, mobile, or ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Source")).toBeInTheDocument();
    expect(screen.getByLabelText("Payment status")).toBeInTheDocument();
    expect(screen.getByLabelText("Issue")).toBeInTheDocument();
    // The advanced filters live inside a native <details> disclosure. Framer
    // Motion's reveal animation leaves ancestor opacity at 0 under jsdom, so
    // this checks the disclosure's own open state rather than jest-dom's
    // computed-style `toBeVisible`.
    const moreFilters = screen.getByText("Date from").closest("details") as HTMLDetailsElement;
    expect(moreFilters.open).toBe(false);

    fireEvent.click(screen.getByText("More filters"));
    expect(moreFilters.open).toBe(true);
  });

  it("opens the shared drawer from Review, returns focus to the trigger on Escape, and shows no per-row evidence/edit/refund-FX buttons", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    const reviewButton = within(table).getByRole("button", { name: "Review" });
    reviewButton.focus();
    fireEvent.click(reviewButton);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("Maya Al Khalifa").length).toBeGreaterThan(0);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reviewButton).toHaveFocus();
  });
});

describe("Sources", () => {
  it("shows Admin-only sync controls, with no manual bank transfer card and no workbook/statement upload", async () => {
    currentSearch = new URLSearchParams("tab=sources");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findByText("Sync Stripe now")).toBeInTheDocument();
    expect(screen.getByText("Sync Tap now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add bank transfer" })).not.toBeInTheDocument();
    expect(screen.queryByText("Import workbook")).not.toBeInTheDocument();
  });

  it("shows a Viewer nothing on Sources", async () => {
    currentSearch = new URLSearchParams("tab=sources");
    stubFetch({ role: "viewer" });
    render(<RoleProvider role="viewer"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findAllByText("Sync requires Admin access.")).toHaveLength(2);
    expect(screen.queryByText("Sync Stripe now")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Tap now")).not.toBeInTheDocument();
    const sourcesPanel = await screen.findByRole("tabpanel", { name: "Sources" });
    expect(within(sourcesPanel).queryByRole("button")).not.toBeInTheDocument();
  });

  it("highlights and scrolls to the linked provider and expands a failed backfill", async () => {
    currentSearch = new URLSearchParams("tab=sources&provider=tap&action=backfill");
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    stubFetch({ role: "admin" });

    try {
      render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

      const tapCard = await screen.findByRole("region", { name: "Tap source controls" });
      const stripeCard = screen.getByRole("region", { name: "Stripe source controls" });
      expect(tapCard).toHaveClass("ring-2", "ring-warning");
      expect(stripeCard).not.toHaveClass("ring-2");
      expect(within(tapCard).getByRole("status")).toHaveTextContent("Failed source run selected");
      expect((within(tapCard).getByText("Historical Tap B2C backfill").closest("details") as HTMLDetailsElement).open).toBe(true);
      expect((within(stripeCard).getByText("Historical Stripe B2C backfill").closest("details") as HTMLDetailsElement).open).toBe(false);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" }));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("Manual bank transfer entry point", () => {
  it("shows Add bank transfer on the Ledger tab for an Admin", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    expect(screen.getByRole("button", { name: "Add bank transfer" })).toBeInTheDocument();
  });

  it("never shows Add bank transfer to a Viewer", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "viewer" });
    render(<RoleProvider role="viewer"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    await screen.findByRole("table", { name: "B2C ledger" });
    expect(screen.queryByRole("button", { name: "Add bank transfer" })).not.toBeInTheDocument();
  });
});

describe("No B2C write control ever reaches a Viewer", () => {
  it("renders zero buttons across Ledger for a Viewer other than filter/disclosure controls", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "viewer" });
    render(<RoleProvider role="viewer"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    // A Viewer may still open the read-only drawer through `Review`; no
    // separate write button (correct/map/FX/exception/post) exists anywhere.
    expect(screen.queryByRole("button", { name: "Add iOS payment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post approved Finance payments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Review" })).toBeInTheDocument();
  });
});
