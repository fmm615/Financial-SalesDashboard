import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cImportVersionDecision } from "@/features/b2c/b2c-import-version-decision";
import { RoleProvider } from "@/lib/auth/role-context";
import type { B2cPendingCandidateRecord } from "@/server/services/b2c-work-items";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const candidate: B2cPendingCandidateRecord = {
  candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  importId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  candidateKind: "ambiguous",
  sourceIdentity: "a".repeat(64),
  financeRowIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
  priorLineageIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
  priorPaymentIds: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
  customerLabel: "Maya Al Khalifa",
  amountUsd: "399.000000",
  occurredOn: "2026-08-01",
};

afterEach(() => {
  vi.unstubAllGlobals();
  refreshMock.mockClear();
});

function renderDecision(role: "admin" | "viewer" = "admin", onSaved = vi.fn()) {
  render(<RoleProvider role={role}><B2cImportVersionDecision candidate={candidate} onSaved={onSaved} /></RoleProvider>);
  return onSaved;
}

describe("B2cImportVersionDecision", () => {
  it("renders all three decisions and submits confirm_new without a target", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ decisionId: "decision-1" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = renderDecision();

    expect(screen.getByRole("radio", { name: "Confirm as a new payment" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Link to an existing Finance lineage" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Link to an existing manual bank transfer" })).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Record import-version decision" });
    fireEvent.change(screen.getByLabelText(/Reason \/ evidence/), { target: { value: "no" } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason \/ evidence/), { target: { value: "Verified against the original workbook." } });
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/b2c/finance-imports/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/lineage-decisions",
      expect.objectContaining({ method: "POST" }),
    ));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      candidateId: candidate.candidateId,
      decision: "confirm_new",
      reason: "Verified against the original workbook.",
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(candidate.candidateId));
  });

  it("requires a manual-payment target before that decision can be submitted", () => {
    renderDecision();
    fireEvent.click(screen.getByRole("radio", { name: "Link to an existing manual bank transfer" }));
    fireEvent.change(screen.getByLabelText(/Reason \/ evidence/), { target: { value: "Verified against transfer confirmation." } });

    const save = screen.getByRole("button", { name: "Record import-version decision" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Manual bank transfer"), { target: { value: candidate.priorPaymentIds[0] } });
    expect(save).toBeEnabled();
  });

  it("keeps the decision controls read-only for a Viewer", () => {
    renderDecision("viewer");
    expect(screen.getByText("Viewer access is read-only. Only an Admin can take this action.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record import-version decision" })).not.toBeInTheDocument();
  });
});
