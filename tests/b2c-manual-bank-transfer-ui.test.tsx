import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { B2cManualBankTransfer } from "@/features/b2c/b2c-manual-bank-transfer";

afterEach(() => vi.unstubAllGlobals());

function fillStepOne() {
  fireEvent.change(screen.getByLabelText("Bank reference"), { target: { value: "IBAN-2026-0912" } });
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Ada Founder" } });
  fireEvent.change(screen.getByLabelText("Customer email"), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText("Bank transfer date/time"), { target: { value: "2026-08-12T08:00" } });
  fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "266" } });
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "membership" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "New bank transfer received after the latest workbook." } });
}

describe("B2cManualBankTransfer", () => {
  it("shows exactly one Add bank transfer action and no Add iOS payment control anywhere", () => {
    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    expect(screen.getByRole("button", { name: "Add bank transfer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add ios payment/i })).not.toBeInTheDocument();
  });

  it("collects the seven required facts plus an optional membership tier in Step 1", () => {
    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));

    for (const label of ["Bank reference", "Customer name", "Customer email", "Bank transfer date/time", "Amount (USD)", "Category", "Reason"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Membership tier (optional)")).toBeInTheDocument();
  });

  it("keeps Preview disabled until every required field is entered", () => {
    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    fillStepOne();
    expect(screen.getByRole("button", { name: "Preview" })).not.toBeDisabled();
  });

  it("advances to Step 2 with a clear submit-enabled state after a clean preview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ assessment: { inputSha256: "a".repeat(64), matchState: "clear", exactMatchHref: null, possibleMatches: [] } }),
    } as Response)));

    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));
    fillStepOne();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByText(/no existing match/i);
    expect(screen.getByRole("button", { name: "Record bank transfer" })).toBeInTheDocument();
  });

  it("shows an existing-record link with no submit action for an exact match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ assessment: { inputSha256: "a".repeat(64), matchState: "exact_existing", exactMatchHref: "/operations/b2c?tab=work&record=existing-1", possibleMatches: [] } }),
    } as Response)));

    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));
    fillStepOne();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByText(/existing payment tracker\/payment found/i);
    expect(screen.queryByRole("button", { name: "Record bank transfer" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /review the existing record/i })).toHaveAttribute("href", "/operations/b2c?tab=work&record=existing-1");
  });

  it("shows a blocked-from-totals warning but still allows submitting a possible duplicate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        assessment: {
          inputSha256: "a".repeat(64), matchState: "possible_duplicate", exactMatchHref: null,
          possibleMatches: [{ recordKind: "provider_payment", recordId: "stripe-1", sourceLabel: "Stripe", occurredOn: "2026-08-12", amountUsd: "266.000000" }],
        },
      }),
    } as Response)));

    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));
    fillStepOne();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByText(/possible duplicate/i);
    expect(screen.getByText(/excluded from totals|blocked from totals|remain excluded|keep it excluded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record bank transfer" })).toBeEnabled();
  });

  it("preserves the entered draft when the Admin goes Back from Step 2", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ assessment: { inputSha256: "a".repeat(64), matchState: "clear", exactMatchHref: null, possibleMatches: [] } }),
    } as Response)));

    render(<B2cManualBankTransfer onRecorded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));
    fillStepOne();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/no existing match/i);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByLabelText("Bank reference")).toHaveValue("IBAN-2026-0912");
    expect(screen.getByLabelText("Customer name")).toHaveValue("Ada Founder");
  });

  it("records the reviewed transfer and calls onRecorded on success", async () => {
    const onRecorded = vi.fn();
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/preview")) return { ok: true, json: async () => ({ assessment: { inputSha256: "a".repeat(64), matchState: "clear", exactMatchHref: null, possibleMatches: [] } }) } as Response;
      return { ok: true, json: async () => ({ payment: { id: "new-payment-1" } }) } as Response;
    }));

    render(<B2cManualBankTransfer onRecorded={onRecorded} />);
    fireEvent.click(screen.getByRole("button", { name: "Add bank transfer" }));
    fillStepOne();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/no existing match/i);
    fireEvent.click(screen.getByRole("button", { name: "Record bank transfer" }));

    await vi.waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    const confirmCall = calls.find((call) => !call.url.includes("/preview"));
    expect(confirmCall?.body).toMatchObject({ bankReference: "IBAN-2026-0912", expectedInputSha256: "a".repeat(64) });
    // Closing after a successful confirmation returns to the one Add bank transfer entry point.
    expect(screen.getByRole("button", { name: "Add bank transfer" })).toBeInTheDocument();
  });
});
