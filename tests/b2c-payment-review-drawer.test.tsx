import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cPaymentReviewDrawer, type B2cPaymentReviewDrawerTarget } from "@/features/b2c/b2c-payment-review-drawer";
import { RoleProvider } from "@/lib/auth/role-context";
import type { B2cReviewRow } from "@/features/b2c/b2c-payment-review-actions";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  refreshMock.mockClear();
});

function baseRow(overrides: Partial<B2cReviewRow> = {}): B2cReviewRow {
  return {
    id: "payment-1", recordType: "Payment", customerName: "Maya Al Khalifa", customerEmail: "maya@example.com", customerPhone: null,
    customerNameEvidenceLabel: null, customerEmailEvidenceLabel: null, customerPhoneEvidenceLabel: null,
    date: "Aug 9, 2026", dateValue: "2026-08-09", amountUsd: "$100.00", amountValueUsd: "100", sourceAmountUsd: "$100.00", sourceOriginalCurrency: "USD", sourceDescription: null, sourceDateValue: "2026-08-09",
    membershipTier: "Monthly", billingInterval: "Monthly", source: "Stripe", paymentStatus: "Completed",
    providerReference: "ch_123", sourceSystem: "stripe", productReference: "price_monthly", hasLocalCorrection: false, localCorrectionFields: [], hasFinanceException: false,
    openReviewFlags: [], issue: null,
    decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "reportable", postingStatus: "not_applicable", blockingReasons: [], explanation: "Every approved reporting rule passed, so this record is reportable." },
    ...overrides,
  } as B2cReviewRow;
}

type FetchHandler = () => { ok: boolean; json: () => Promise<unknown> };

function stubFetchByUrl(handlers: Array<[string, FetchHandler]>) {
  const defaultAuditHistory: FetchHandler = () => ({ ok: true, json: async () => ({ entries: [] }) });
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) return Promise.resolve(handler());
    }
    if (url.includes("/audit-history")) return Promise.resolve(defaultAuditHistory());
    return Promise.resolve({ ok: false, json: async () => ({ error: "not mocked in this test" }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDrawer(target: B2cPaymentReviewDrawerTarget | null, role: "admin" | "viewer" = "admin", onClose = vi.fn()) {
  render(<RoleProvider role={role}><B2cPaymentReviewDrawer target={target} onClose={onClose} /></RoleProvider>);
  return onClose;
}

describe("B2C payment review drawer", () => {
  it("shows a ready card and reporting status for a reportable row, then moves focus to Close", async () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("What this record needs")).toBeInTheDocument();
    expect(within(dialog).getByText("Ready to report — nothing needed")).toBeInTheDocument();
    expect(within(dialog).getByText("Reportable")).toBeInTheDocument();
    expect(within(dialog).queryByText("Every approved reporting rule passed, so this record is reportable.")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Local values")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Finance decision")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close record drawer" })).toHaveFocus());
  });

  it("returns focus to the previously focused element on close", () => {
    stubFetchByUrl([]);
    render(<button type="button">Open record</button>);
    const opener = screen.getByRole("button", { name: "Open record" });
    opener.focus();
    expect(opener).toHaveFocus();

    const onClose = vi.fn();
    const { rerender } = render(<RoleProvider role="admin"><B2cPaymentReviewDrawer target={{ kind: "row", row: baseRow() }} onClose={onClose} /></RoleProvider>);
    rerender(<RoleProvider role="admin"><B2cPaymentReviewDrawer target={null} onClose={onClose} /></RoleProvider>);
    expect(opener).toHaveFocus();
  });

  it("closes on Escape", () => {
    stubFetchByUrl([]);
    const onClose = renderDrawer({ kind: "row", row: baseRow() });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("contains its own scrolling instead of scrolling the whole page", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });
    const backdrop = screen.getByRole("presentation");
    const dialog = screen.getByRole("dialog");
    expect(backdrop.className).toContain("overflow-hidden");
    expect(dialog.className).toContain("overflow-y-auto");
  });

  it("puts source evidence and audit history inside one closed disclosure", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");
    const summary = within(dialog).getByText("Show source evidence & history");
    const disclosure = summary.closest("details");

    expect(disclosure).not.toHaveAttribute("open");
    expect(within(disclosure as HTMLElement).getByText("Source evidence")).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText("Audit history")).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText("ch_123")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Source evidence")).toHaveLength(1);
    expect(within(dialog).getAllByText("Audit history")).toHaveLength(1);
  });

  it("exposes exactly one drawer action instead of separate evidence/edit triggers", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "View Stripe details" })).not.toBeInTheDocument();
  });

  it("renders every blocking reason as a visible card and expands only the first by default", () => {
    stubFetchByUrl([]);
    const row = baseRow({
      customerEmail: null,
      amountValueUsd: null,
      amountUsd: "—",
      openReviewFlags: [{ id: "missing-email", type: "Missing customer email", reason: "Stripe did not provide a customer email." }],
      decision: {
        sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable",
        blockingReasons: ["missing_amount", "missing_business_date", "missing_customer_email"],
        explanation: "Blocked by an unavailable USD amount, an unavailable business date, a missing customer email.",
      },
    });
    renderDrawer({ kind: "row", row });
    const dialog = screen.getByRole("dialog");
    const amountCard = within(dialog).getByText("Missing amount").closest("details") as HTMLElement;
    const dateCard = within(dialog).getByText("Missing business date").closest("details") as HTMLElement;
    const emailCard = within(dialog).getByText("Missing customer email").closest("details") as HTMLElement;

    expect(within(dialog).getByText("Blocked")).toBeInTheDocument();
    expect(amountCard).toHaveAttribute("open");
    expect(dateCard).not.toHaveAttribute("open");
    expect(emailCard).not.toHaveAttribute("open");
    expect(within(amountCard).getByLabelText("Local B2C amount (USD)")).toBeInTheDocument();
    expect(within(amountCard).getByRole("button", { name: "Save amount" })).toBeInTheDocument();
    expect(within(amountCard).queryByLabelText("Local business date")).not.toBeInTheDocument();
    expect(within(dateCard).getByLabelText("Local business date")).toBeInTheDocument();
    expect(within(dateCard).getByRole("button", { name: "Save date" })).toBeInTheDocument();
    expect(within(emailCard).getByLabelText("Customer email")).toBeInTheDocument();
    expect(within(emailCard).getByRole("button", { name: "Save email" })).toBeInTheDocument();
    expect(within(emailCard).getByText("Include without email")).toBeInTheDocument();
  });

  it.each([
    { reason: "failed_payment" as const, title: "Payment failed", tag: "No action needed", paymentStatus: "Failed" as const, reportingDecision: "blocked" as const },
    { reason: "pending_payment" as const, title: "Payment pending", tag: "No action needed", paymentStatus: "Pending" as const, reportingDecision: "blocked" as const },
    { reason: "duplicate_exclusion" as const, title: "Excluded as duplicate", tag: "No action needed", paymentStatus: "Completed" as const, reportingDecision: "excluded" as const },
    { reason: "other_open_review" as const, title: "Open review item", tag: "No action needed here yet", paymentStatus: "Completed" as const, reportingDecision: "blocked" as const },
  ])("shows $title honestly without an action button", ({ reason, title, tag, paymentStatus, reportingDecision }) => {
    stubFetchByUrl([]);
    const reviewReason = "Finance needs the provider discrepancy investigated before reporting.";
    const row = baseRow({
      paymentStatus,
      duplicateExclusionReason: reason === "duplicate_exclusion" ? "Finance kept the settled Stripe charge and excluded this duplicate." : null,
      openReviewFlags: reason === "other_open_review" ? [{ id: "follow-up", type: "Needs follow-up", reason: reviewReason }] : [],
      decision: {
        sourceStatus: reason === "failed_payment" ? "failed" : reason === "pending_payment" ? "pending" : "succeeded",
        reconciliationStatus: "not_required", reportingDecision, postingStatus: "not_applicable",
        blockingReasons: [reason], explanation: "This record is not currently reportable.",
      },
    });
    renderDrawer({ kind: "row", row });
    const card = screen.getByText(title).closest("details") as HTMLElement;

    expect(within(card).getByText(tag)).toBeInTheDocument();
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    if (reason === "other_open_review") expect(within(card).getByText(reviewReason)).toBeInTheDocument();
    if (reason === "duplicate_exclusion") {
      expect(screen.getByText("Excluded")).toBeInTheDocument();
      expect(within(card).getByText("Finance kept the settled Stripe charge and excluded this duplicate.")).toBeInTheDocument();
    }
  });

  it("falls back to the decision explanation when an audited duplicate-exclusion reason is unavailable", () => {
    stubFetchByUrl([]);
    const explanation = "This payment was excluded by an audited duplicate decision.";
    renderDrawer({ kind: "row", row: baseRow({
      duplicateExclusionReason: null,
      decision: {
        sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "excluded", postingStatus: "not_applicable",
        blockingReasons: ["duplicate_exclusion"], explanation,
      },
    }) });

    const card = screen.getByText("Excluded as duplicate").closest("details") as HTMLElement;
    expect(within(card).getByText(explanation)).toBeInTheDocument();
  });

  it("does not reveal the Admin-only duplicate-exclusion reason to a Viewer", () => {
    stubFetchByUrl([]);
    const auditedReason = "Finance selected another provider charge as canonical.";
    const explanation = "This payment was excluded by an audited duplicate decision.";
    renderDrawer({ kind: "row", row: baseRow({
      duplicateExclusionReason: auditedReason,
      decision: {
        sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "excluded", postingStatus: "not_applicable",
        blockingReasons: ["duplicate_exclusion"], explanation,
      },
    }) }, "viewer");

    const card = screen.getByText("Excluded as duplicate").closest("details") as HTMLElement;
    expect(within(card).queryByText(auditedReason)).not.toBeInTheDocument();
    expect(within(card).getByText(explanation)).toBeInTheDocument();
  });

  it("uses the shared one-card disclosure for a refund with no further Finance decision", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow({
      recordType: "Refund",
      paymentStatus: "Refunded",
      amountUsd: "−$100.00",
      decision: {
        sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "reportable", postingStatus: "not_applicable",
        blockingReasons: [], explanation: "This refund is ready for reporting.",
      },
    }) });

    const card = screen.getByText("Refund review complete").closest("details") as HTMLElement;
    expect(card).toHaveAttribute("open");
    expect(within(card).getByText("This refund needs no further Finance decision.")).toBeInTheDocument();
  });

  it("shows the included-by-exception reporting status", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow({
      hasFinanceException: true,
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "exception_included", postingStatus: "not_applicable", blockingReasons: [], explanation: "Included by an audited Finance exception; every other blocking rule still passed." },
    }) });

    expect(screen.getByText("Included by exception")).toBeInTheDocument();
  });

  it("uses the focused FX conversion action when that remains the unresolved financial blocker", () => {
    stubFetchByUrl([]);
    const row = baseRow({
      isForeignCurrency: true,
      foreignCurrencyReview: true,
      hasFxConversion: false,
      sourceOriginalCurrency: "BHD",
      sourceAmountUsd: "37.70 BHD",
      openReviewFlags: [],
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["missing_fx"], explanation: "Blocked by a foreign-currency amount awaiting an approved conversion." },
    });
    renderDrawer({ kind: "row", row });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Needs currency conversion")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("USD per 1 BHD")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save conversion" })).toBeInTheDocument();
  });

  it("keeps an unmapped provider payment reviewable without offering a reusable mapping", async () => {
    const fetchMock = stubFetchByUrl([["/evidence", () => ({ ok: true, json: async () => ({
      paymentId: "payment-1", source: "Stripe", sourceSystem: "stripe", providerReference: "ch_123", date: "Aug 9, 2026",
      stripeEvidence: {
        originalCurrency: "USD", originalAmount: "100.00", amountRefunded: "0", description: "Founding Membership", sellerMessage: null, cardholderName: null,
        settlementGrossAmount: null, settlementCurrency: null, settlementExchangeRate: null, settlementFeeAmount: null, settlementFeeTaxAmount: null, settlementNetAmount: null, refunds: [],
      },
    }) })]]);
    const row = baseRow({
      customerEmail: null,
      sourceDescription: "Founding Membership",
      openReviewFlags: [
        { id: "missing-email", type: "Missing customer email", reason: "Stripe did not provide a customer email." },
        { id: "unmapped", type: "Unmapped product" as never, reason: "The retained mapping flag is historical evidence." },
      ],
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["missing_customer_email"], explanation: "Blocked by a missing customer email." },
    });
    renderDrawer({ kind: "row", row });
    const dialog = screen.getByRole("dialog");

    await screen.findByText("Founding Membership");
    const includeSummary = within(dialog).getByText("Include without email");
    const includeDisclosure = includeSummary.closest("details") as HTMLElement;
    expect(includeDisclosure).not.toHaveAttribute("open");
    fireEvent.click(includeSummary);
    expect(includeDisclosure).toHaveAttribute("open");
    expect(within(dialog).queryByText("Create reusable product mapping")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Internal product code")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save local product mapping" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("approved product mapping")).not.toBeInTheDocument();

    const includeButton = within(dialog).getByRole("button", { name: "Include in PLAYBOOK Finance" });
    expect(includeButton).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/exact provider payment ID/i));
    fireEvent.click(within(dialog).getByLabelText(/found no known duplicate/i));
    fireEvent.change(within(includeDisclosure).getByLabelText(/Reason \/ evidence/), { target: { value: "Finance verified the missing email cannot be recovered." } });
    expect(includeButton).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/b2c/products/map", expect.anything());
  });

  it("preserves the draft and shows an error when a save fails, without closing the drawer", async () => {
    stubFetchByUrl([["/correct", () => ({ ok: false, json: async () => ({ error: "The local B2C correction could not be saved." }) })]]);
    const onClose = renderDrawer({ kind: "row", row: baseRow({
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["missing_amount"], explanation: "Blocked by an unavailable USD amount." },
    }) });
    const dialog = screen.getByRole("dialog");
    const card = within(dialog).getByText("Missing amount").closest("details") as HTMLElement;

    const amountInput = within(card).getByLabelText("Local B2C amount (USD)");
    fireEvent.change(amountInput, { target: { value: "125.50" } });
    fireEvent.change(within(card).getByLabelText(/Reason \/ evidence/), { target: { value: "Verified against Finance evidence." } });
    fireEvent.click(within(card).getByRole("button", { name: "Save amount" }));

    await screen.findByText("The local B2C correction could not be saved.");
    expect(amountInput).toHaveValue(125.5);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only signals the queue to refresh after the server confirms a successful save", async () => {
    stubFetchByUrl([["/correct", () => ({ ok: true, json: async () => ({ ok: true }) })]]);
    const onClose = renderDrawer({ kind: "row", row: baseRow({
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["missing_amount"], explanation: "Blocked by an unavailable USD amount." },
    }) });
    const dialog = screen.getByRole("dialog");
    const card = within(dialog).getByText("Missing amount").closest("details") as HTMLElement;

    fireEvent.change(within(card).getByLabelText("Local B2C amount (USD)"), { target: { value: "125.50" } });
    fireEvent.change(within(card).getByLabelText(/Reason \/ evidence/), { target: { value: "Verified against Finance evidence." } });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Save amount" }));

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("hides Admin write sections and never fetches Admin-only evidence for a Viewer", () => {
    const fetchMock = stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow({
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["missing_amount"], explanation: "Blocked by an unavailable USD amount." },
    }) }, "viewer");
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getAllByText("Viewer access is read-only. Only an Admin can take this action.").length).toBeGreaterThan(0);
    expect(within(dialog).queryByLabelText("Local B2C amount (USD)")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Full Stripe charge and settlement evidence is Admin-only.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/evidence"), expect.anything());
  });

  it("always offers an Other details card for optional metadata, closed by default, regardless of blocking reasons", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");
    const card = within(dialog).getByText("Other details").closest("details") as HTMLElement;

    expect(card).not.toHaveAttribute("open");
    expect(within(card).getByLabelText("Customer name")).toBeInTheDocument();
    expect(within(card).getByLabelText("Customer mobile")).toBeInTheDocument();
    expect(within(card).getByLabelText("Plan / tier")).toBeInTheDocument();
  });

  it("saves an audited correction to customer name, mobile, and plan/tier from the Other details card", async () => {
    const fetchMock = stubFetchByUrl([["/correct", () => ({ ok: true, json: async () => ({ ok: true }) })]]);
    const onClose = renderDrawer({ kind: "row", row: baseRow({ customerPhone: null }) });
    const dialog = screen.getByRole("dialog");
    const card = within(dialog).getByText("Other details").closest("details") as HTMLElement;

    fireEvent.change(within(card).getByLabelText("Customer mobile"), { target: { value: "+973 3000 0000" } });
    fireEvent.change(within(card).getByLabelText(/Reason \/ evidence/), { target: { value: "Finance confirmed the customer's mobile number." } });
    fireEvent.click(within(card).getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/b2c/payments/payment-1/correct", expect.objectContaining({
      body: JSON.stringify({ customerPhone: "+973 3000 0000", reason: "Finance confirmed the customer's mobile number." }),
    }));
  });

  it("hides the Other details save controls from a Viewer", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() }, "viewer");
    const dialog = screen.getByRole("dialog");
    const card = within(dialog).getByText("Other details").closest("details") as HTMLElement;

    expect(within(card).getByText("Viewer access is read-only. Only an Admin can take this action.")).toBeInTheDocument();
    expect(within(card).queryByLabelText("Customer name")).not.toBeInTheDocument();
  });

  it("does not offer a quick-fill button for an already-shown fallback value -- it needs no confirmation to count", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow({
      customerName: "Arshiya Kherani",
      customerNameEvidenceLabel: "Stripe profile",
      customerEmail: "arshiya@arshiyakherani.com",
      customerEmailEvidenceLabel: "Stripe profile",
      customerPhone: "+973 00000000",
      customerPhoneEvidenceLabel: "Stripe profile",
    }) });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).queryByRole("button", { name: /Use the Stripe profile/ })).not.toBeInTheDocument();
  });

  it("treats a historical Finance-Tracker row the same as any other payment for local correction (the posted-adjustment path was removed with Payment Tracker)", () => {
    stubFetchByUrl([]);
    const row = baseRow({
      id: "85edf4fe-346b-483a-8053-199e6b1e2961",
      customerName: "Hoor Alshubbar",
      source: "Finance",
      sourceSystem: "finance_tracker",
      providerReference: null,
      productReference: null,
      date: "Nov 1, 2026", dateValue: "2026-11-01", sourceDateValue: "2026-11-01",
      amountUsd: "$48.45", amountValueUsd: "48.45", sourceAmountUsd: "$48.45",
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "posted", blockingReasons: ["implausible_future_date"], explanation: "Blocked by a business date that has not happened yet." },
    });
    renderDrawer({ kind: "row", row });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Business date looks wrong")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Local business date")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save corrected date" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/already posted to Finance/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Record posted Finance adjustment" })).not.toBeInTheDocument();
  });
});
