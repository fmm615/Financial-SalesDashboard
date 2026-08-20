import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cWorkspace } from "@/features/b2c/b2c-workspace";
import { RoleProvider } from "@/lib/auth/role-context";
import type { B2cDashboardSnapshot } from "@/server/repositories/b2c-dashboard-repository";
import type { B2cSafeLedgerRow } from "@/features/b2c/b2c-ledger-table";

let currentSearch = new URLSearchParams();
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/operations/b2c",
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => currentSearch,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  pushMock.mockClear();
  currentSearch = new URLSearchParams();
});

const snapshot: B2cDashboardSnapshot = {
  period: { month: "2026-08", monthLabel: "August 2026", monthStart: "2026-08-01", monthEnd: "2026-08-31" },
  sourceCoverage: { reportingTotalsReady: true, state: "ready", dataAsOf: "2026-08-19T12:00:00.000Z", title: "B2C financial totals are ready", description: "Source history is complete." },
  hasSourceRecords: true, eligiblePaymentsUsd: "$150.00", refundsUsd: "$10.00", netPaymentsUsd: "$140.00", completedSourcePaymentsUsd: "$160.00", sourceRefundsUsd: "$10.00",
  calculation: { completedSourcePaymentCount: 2, reportablePaymentCount: 2, excludedCompletedPaymentCount: 0, excludedCompletedPaymentsUsd: "$0.00", sourceRefundCount: 1, eligibleRefundCount: 1, missingCustomerEmailCount: 0, unmappedProductCount: 0, possibleDuplicateCount: 0, otherReviewCount: 0, nonSucceededPaymentCount: 0, financeExceptionPaymentCount: 0 },
  reviewItems: 2, rows: [],
};

const ledgerRow: B2cSafeLedgerRow = {
  id: "payment-1", recordType: "Payment" as const, customerName: "Maya Al Khalifa", customerEmail: "maya@example.com", customerPhone: null,
  customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
  date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$100.00", amountValueUsd: "100", sourceAmountUsd: "$100.00", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-09",
  category: "membership", membershipTier: "Monthly", billingInterval: "Monthly", source: "Stripe", paymentStatus: "Completed" as const,
  providerReference: "ch_123", sourceSystem: "stripe" as const, productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
  openReviewFlags: [], issue: null,
  decision: { sourceStatus: "succeeded" as const, reconciliationStatus: "not_required" as const, reportingDecision: "reportable" as const, postingStatus: "not_applicable" as const, blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
};

const workItems = {
  items: [
    { id: "payment-2:missing_amount", recordId: "payment-2", recordKind: "provider_payment" as const, queue: "data_quality" as const, visibleGroup: "data" as const, financeMethod: null, title: "Enter the missing amount for Sam", explanation: "This record has no available USD amount.", financialImpactUsd: null, nextAction: "correct" as const, href: "/operations/b2c?tab=work&record=payment-2" },
    { id: "payment-3:possible_duplicate", recordId: "payment-3", recordKind: "provider_payment" as const, queue: "duplicate" as const, visibleGroup: "duplicates" as const, financeMethod: null, title: "Choose the duplicate for Noor", explanation: "This record has an unresolved possible duplicate.", financialImpactUsd: "$40.00", nextAction: "choose_duplicate" as const, href: "/operations/b2c?tab=work&record=payment-3" },
    { id: "run-1:source_failure", recordId: "run-1", recordKind: "source_run" as const, queue: "source_failure" as const, visibleGroup: "reconciliation" as const, financeMethod: null, title: "Retry the Stripe sync", explanation: "The last Stripe sync failed. Retry it from Sources.", financialImpactUsd: null, nextAction: "retry_source" as const, href: "/operations/b2c?tab=sources" },
    { id: "ready-to-post", recordId: "ready-to-post", recordKind: "finance_row" as const, queue: "ready_to_post" as const, visibleGroup: "ready_to_post" as const, financeMethod: null, title: "Post 2 Finance payments", explanation: "1 iOS and 1 bank transfer Finance rows are ready to post.", financialImpactUsd: null, nextAction: "post" as const, href: "/operations/b2c?tab=work&queue=ready_to_post" },
  ],
  counts: { all: 4, data: 1, duplicates: 1, reconciliation: 1, ready_to_post: 1 },
};

function stubFetch(overrides: { role?: "admin" | "viewer"; ledgerRows?: B2cSafeLedgerRow[] } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/b2c/workspace")) {
      const role = overrides.role ?? "admin";
      const rows = overrides.ledgerRows ?? [ledgerRow];
      return { ok: true, json: async () => ({ role, ledger: { rows, nextCursor: null, hasMore: false, totalCount: rows.length }, workItems: role === "admin" ? workItems : null }) };
    }
    if (url.includes("/api/b2c/reconciliation")) {
      return { ok: true, json: async () => ({ summary: {
        publicationState: "not_fully_loaded", publicationMessage: "Not published.",
        sources: [
          { key: "stripe_charges", label: "Stripe Charges", status: "completed" },
          { key: "tap_statement", label: "Tap statement", status: "pending" },
          { key: "payment_tracker", label: "Payment Tracker", status: "pending" },
        ],
        counts: { stagedRows: 0, validRows: 0, needsReviewRows: 0, zeroValueRows: 0, invalidRows: 0, unresolvedGroups: 0 },
      } }) };
    }
    return { ok: false, json: async () => ({ error: "unexpected" }) };
  }));
}

describe("B2cWorkspace tab defaults and URL state", () => {
  it("defaults an Admin to the Work queue", async () => {
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const tablist = await screen.findByRole("tablist", { name: "B2C workspace" });
    expect(within(tablist).getByRole("tab", { name: "Work queue", selected: true })).toBeInTheDocument();
    expect(await screen.findByText("Enter the missing amount for Sam")).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Post approved Finance payments" })).toBeInTheDocument();
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
  it("shows five filter chips with counts and exactly one primary action per item", async () => {
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const chips = await screen.findByRole("group", { name: "Work queue filters" });
    for (const [label, count] of [["All", "4"], ["Data", "1"], ["Duplicates", "1"], ["Reconciliation", "1"], ["Ready to post", "1"]]) {
      expect(within(chips).getByRole("button", { name: new RegExp(`^${label} ${count}$`) })).toBeInTheDocument();
    }

    const dataItem = (await screen.findByText("Enter the missing amount for Sam")).closest("li");
    expect(dataItem).not.toBeNull();
    expect(within(dataItem as HTMLElement).getAllByRole("button")).toHaveLength(1);
    expect(within(dataItem as HTMLElement).getByRole("button", { name: "Correct" })).toBeInTheDocument();
  });

  it("renders the one Ready-to-post container instead of a second Post button", async () => {
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findByRole("button", { name: "Post approved Finance payments" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Post approved Finance payments" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Post" })).not.toBeInTheDocument();
  });

  it("filters to the Duplicates chip without a bulk Find-exact-duplicates or bulk Date-acceptance control", async () => {
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const chips = await screen.findByRole("group", { name: "Work queue filters" });
    fireEvent.click(within(chips).getByRole("button", { name: /^Duplicates 1$/ }));

    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("queue=duplicates"));
    expect(screen.queryByRole("button", { name: "Find exact duplicates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept.*date/i })).not.toBeInTheDocument();
  });
});

describe("Ledger", () => {
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

  it("shows a provider's decline/seller message beside the description when one is retained", async () => {
    currentSearch = new URLSearchParams("tab=ledger");
    stubFetch({ role: "admin", ledgerRows: [{ ...ledgerRow, sourceDescription: "Subscription update", sourceSellerMessage: "Your card was declined: insufficient funds." }] });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    const table = await screen.findByRole("table", { name: "B2C ledger" });
    expect(within(table).getByText("Subscription update")).toBeInTheDocument();
    expect(within(table).getByText("Your card was declined: insufficient funds.")).toBeInTheDocument();
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
  it("shows Admin-only sync/upload controls and the one live Add bank transfer action", async () => {
    currentSearch = new URLSearchParams("tab=sources");
    stubFetch({ role: "admin" });
    render(<RoleProvider role="admin"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findByText("Sync Stripe now")).toBeInTheDocument();
    expect(screen.getByText("Sync Tap now")).toBeInTheDocument();
    expect(screen.getByText("Import workbook")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add bank transfer" })).toBeInTheDocument();
    expect(screen.queryByText(/Coming soon/)).not.toBeInTheDocument();
  });

  it("shows a Viewer read-only coverage without any action control", async () => {
    currentSearch = new URLSearchParams("tab=sources");
    stubFetch({ role: "viewer" });
    render(<RoleProvider role="viewer"><B2cWorkspace snapshot={snapshot} /></RoleProvider>);

    expect(await screen.findByText("Required source coverage")).toBeInTheDocument();
    expect(screen.queryByText("Sync Stripe now")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Tap now")).not.toBeInTheDocument();
    expect(screen.queryByText("Import workbook")).not.toBeInTheDocument();
    const sourcesPanel = await screen.findByRole("tabpanel", { name: "Sources" });
    expect(within(sourcesPanel).queryByRole("button")).not.toBeInTheDocument();
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
    expect(within(table).getByRole("button", { name: "Review" })).toBeInTheDocument();
  });
});
