import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cStagingDateAuthority } from "@/features/b2c/b2c-staging-date-authority";
import { RoleProvider } from "@/lib/auth/role-context";
import { buildB2cWorkspaceOverview, selectActionableB2cStagingDateAuthorityRows } from "@/server/repositories/b2c-workspace-repository";
import type { B2cFinanceNeedsReviewRow } from "@/server/services/b2c-finance-action-center";

afterEach(() => vi.unstubAllGlobals());

const row = {
  financeRowId: "11111111-1111-4111-8111-111111111111",
  sourceTab: "B2C" as const,
  sourceRowNumber: 42,
  declaredMonth: "September",
  declaredYear: "2025",
  occurredOn: "2026-08-11",
};

describe("B2cStagingDateAuthority", () => {
  it("shows the conflicting declared labels and parsed Date before submitting exactly one reviewed row", async () => {
    const onSaved = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ resolvedRows: 1 }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoleProvider role="admin"><B2cStagingDateAuthority row={row} onSaved={onSaved} /></RoleProvider>);

    expect(screen.getByText("B2C row 42")).toBeInTheDocument();
    expect(screen.getByText("September")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
    expect(screen.getByText("2026-08-11")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Confirm parsed Date" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason \/ evidence/), { target: { value: "Finance verified the signed workbook Date is authoritative." } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/b2c/finance-actions/date-authority",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          financeRowIds: ["11111111-1111-4111-8111-111111111111"],
          reason: "Finance verified the signed workbook Date is authoritative.",
        }),
      }),
    ));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(row.financeRowId));
  });

  it("keeps the evidence and draft reason visible after a rejected save", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Date conflict is no longer actionable." }) }));
    render(<RoleProvider role="admin"><B2cStagingDateAuthority row={row} onSaved={vi.fn()} /></RoleProvider>);

    fireEvent.change(screen.getByLabelText(/Reason \/ evidence/), { target: { value: "Finance verified the signed workbook Date is authoritative." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm parsed Date" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Date conflict is no longer actionable.");
    expect(screen.getByText("September")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason \/ evidence/)).toHaveValue("Finance verified the signed workbook Date is authoritative.");
  });
});

describe("staging date-authority workspace item", () => {
  it("uses the data queue and a dedicated drawer route instead of a Finance duplicate or payment record action", () => {
    const overview = buildB2cWorkspaceOverview({
      ledgerRows: [],
      stagingDateAuthorityRows: [row],
    });

    expect(overview.counts).toMatchObject({ all: 1, data: 1, duplicates: 0, reconciliation: 0 });
    expect(overview.items).toEqual([expect.objectContaining({
      id: "staging-date-authority:11111111-1111-4111-8111-111111111111",
      recordId: "11111111-1111-4111-8111-111111111111",
      recordKind: "finance_row",
      nextAction: "correct",
      href: "/operations/b2c?tab=work&dateAuthority=11111111-1111-4111-8111-111111111111",
    })]);
  });

  it("excludes corrected, confirmed, posted, and mixed-issue rows while retaining exactly actionable date conflicts", () => {
    const needsReviewRow = (financeRowId: string, qualityIssues: string[]): B2cFinanceNeedsReviewRow => ({
      financeRowId,
      sourceTab: "B2C",
      sourceRowNumber: 42,
      reportedDateRaw: "11/08/2026",
      declaredMonth: "September",
      declaredYear: "2025",
      occurredOn: "2026-08-11",
      amountUsd: "100.000000",
      customerName: "Maya Al Khalifa",
      customerEmail: null,
      customerPhone: null,
      category: "membership",
      membershipType: null,
      paymentMethod: "ios",
      paymentStatus: "received",
      note: null,
      qualityIssues,
    });
    const correctedId = "11111111-1111-4111-8111-111111111111";
    const confirmedId = "22222222-2222-4222-8222-222222222222";
    const postedId = "33333333-3333-4333-8333-333333333333";
    const mixedIssueId = "44444444-4444-4444-8444-444444444444";
    const actionableId = "55555555-5555-4555-8555-555555555555";

    expect(selectActionableB2cStagingDateAuthorityRows(
      [
        needsReviewRow(correctedId, ["declared_month_conflicts_with_date"]),
        needsReviewRow(confirmedId, ["declared_year_conflicts_with_date"]),
        needsReviewRow(postedId, ["declared_month_conflicts_with_date"]),
        needsReviewRow(mixedIssueId, ["declared_month_conflicts_with_date", "missing_customer_name"]),
        needsReviewRow(actionableId, ["declared_month_conflicts_with_date", "declared_year_conflicts_with_date"]),
      ],
      new Map([
        [correctedId, { occurredOn: "2026-08-10", dateAuthorityConfirmedAt: null }],
        [confirmedId, { occurredOn: null, dateAuthorityConfirmedAt: "2026-08-20T00:00:00.000Z" }],
      ]),
      new Set([postedId]),
    )).toEqual([expect.objectContaining({ financeRowId: actionableId, occurredOn: "2026-08-11" })]);
  });
});
