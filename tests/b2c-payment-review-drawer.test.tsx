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
    category: "membership", membershipTier: "Monthly", billingInterval: "Monthly", source: "Stripe", paymentStatus: "Completed",
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
  it("renders every drawer section for an Admin and moves focus to Close", async () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Source evidence")).toBeInTheDocument();
    expect(within(dialog).getByText("Local values")).toBeInTheDocument();
    expect(within(dialog).getByText("Finance decision")).toBeInTheDocument();
    expect(within(dialog).getByText("Audit history")).toBeInTheDocument();
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

  it("shows source and local values as visually separate sections", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");
    // The Stripe reference lives only under Source evidence, never repeated inside Local values.
    const sourceHeading = within(dialog).getByText("Source evidence");
    const localHeading = within(dialog).getByText("Local values");
    expect(sourceHeading).not.toBe(localHeading);
    expect(within(dialog).getAllByText("ch_123").length).toBeGreaterThanOrEqual(1);
    expect(within(localHeading.closest("div") as HTMLElement).queryByText("ch_123")).not.toBeInTheDocument();
  });

  it("exposes exactly one drawer action instead of separate evidence/edit triggers", () => {
    stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "View Stripe details" })).not.toBeInTheDocument();
  });

  it("shows one primary Finance-decision action with everything else under More actions", () => {
    stubFetchByUrl([]);
    const row = baseRow({
      category: "Unmapped",
      isForeignCurrency: true,
      foreignCurrencyReview: false,
      hasFxConversion: true,
      openReviewFlags: [{ id: "flag-1", type: "Unmapped product", reason: "Stripe did not provide a mapped product." }],
      decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "not_applicable", blockingReasons: ["unmapped_category"], explanation: "Blocked by an unmapped category." },
    });
    renderDrawer({ kind: "row", row });
    const dialog = screen.getByRole("dialog");

    // "map" is primary: expanded outside "More actions".
    expect(within(dialog).getByText("Create reusable product mapping")).toBeInTheDocument();
    const moreActions = within(dialog).getByText("More actions").closest("details") as HTMLElement;
    expect(within(moreActions).queryByText("Create reusable product mapping")).not.toBeInTheDocument();
    // FX conversion is available but secondary, collapsed under "More actions".
    expect(within(moreActions).getByText(/Finance USD conversion/)).toBeInTheDocument();
  });

  it("preserves the draft and shows an error when a save fails, without closing the drawer", async () => {
    stubFetchByUrl([["/correct", () => ({ ok: false, json: async () => ({ error: "The local B2C correction could not be saved." }) })]]);
    const onClose = renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");

    const nameInput = within(dialog).getByLabelText("Customer name");
    fireEvent.change(nameInput, { target: { value: "Corrected Name" } });
    fireEvent.change(within(dialog).getByLabelText(/Reason \/ evidence/), { target: { value: "Verified against Finance evidence." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save audited local correction" }));

    await screen.findByText("The local B2C correction could not be saved.");
    expect(nameInput).toHaveValue("Corrected Name");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only signals the queue to refresh after the server confirms a successful save", async () => {
    stubFetchByUrl([["/correct", () => ({ ok: true, json: async () => ({ ok: true }) })]]);
    const onClose = renderDrawer({ kind: "row", row: baseRow() });
    const dialog = screen.getByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("Customer name"), { target: { value: "Corrected Name" } });
    fireEvent.change(within(dialog).getByLabelText(/Reason \/ evidence/), { target: { value: "Verified against Finance evidence." } });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save audited local correction" }));

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("hides Admin write sections and never fetches Admin-only evidence for a Viewer", () => {
    const fetchMock = stubFetchByUrl([]);
    renderDrawer({ kind: "row", row: baseRow() }, "viewer");
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getAllByText("Viewer access is read-only. Only an Admin can take this action.").length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByText("Full Stripe charge and settlement evidence is Admin-only.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/evidence"), expect.anything());
  });

  describe("posted Finance Tracker adjustment (Hoor Alshubbar scenario)", () => {
    function postedRow(): B2cReviewRow {
      return baseRow({
        id: "85edf4fe-346b-483a-8053-199e6b1e2961",
        customerName: "Hoor Alshubbar",
        source: "Finance — iOS",
        sourceSystem: "finance_tracker",
        providerReference: null,
        productReference: null,
        date: "Nov 1, 2026", dateValue: "2026-11-01", sourceDateValue: "2026-11-01",
        amountUsd: "$48.45", amountValueUsd: "48.45", sourceAmountUsd: "$48.45",
        decision: { sourceStatus: "succeeded", reconciliationStatus: "not_required", reportingDecision: "blocked", postingStatus: "posted", blockingReasons: ["implausible_future_date"], explanation: "Blocked by a business date that has not happened yet." },
      });
    }

    it("shows the calculated effect before confirmation and never lets the browser submit without the expected current values", async () => {
      const fetchMock = stubFetchByUrl([
        ["/finance-adjustments", () => ({ ok: true, json: async () => ({ context: { paymentId: "85edf4fe-346b-483a-8053-199e6b1e2961", currentAmountUsd: "48.450000", currentOccurredOn: "2026-11-01", history: [] } }) })],
      ]);
      renderDrawer({ kind: "row", row: postedRow() });
      const dialog = screen.getByRole("dialog");

      await screen.findByText(/already posted to Finance/);
      // The Local values section explains the append-only path instead of offering a local overlay for a posted payment.
      expect(within(dialog).getByText(/corrected only through the append-only Finance decision/)).toBeInTheDocument();
      expect(within(dialog).getByText("Current posted amount")).toBeInTheDocument();
      expect(within(dialog).getByText("48.450000 USD")).toBeInTheDocument();
      expect(within(dialog).getByText("2026-11-01")).toBeInTheDocument();

      fireEvent.change(within(dialog).getByLabelText("Corrected reporting date"), { target: { value: "2025-11-01" } });
      fireEvent.change(within(dialog).getByLabelText(/Reason \/ evidence/), { target: { value: "Finance verified the true business date from the source statement." } });

      await screen.findByText(/changing the effective posted balance from/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Record posted Finance adjustment" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/b2c/payments/85edf4fe-346b-483a-8053-199e6b1e2961/finance-adjustments",
        expect.objectContaining({ method: "POST" }),
      ));
      const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
      expect(body).toEqual({
        expectedOccurredOn: "2026-11-01",
        expectedAmountUsd: "48.450000",
        verifiedOccurredOn: "2025-11-01",
        reason: "Finance verified the true business date from the source statement.",
      });
      expect(body.verifiedAmountUsd).toBeUndefined();
    });
  });
});
