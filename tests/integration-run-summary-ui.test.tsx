import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntegrationRunSummary } from "@/features/admin/integration-run-summary";
import { StripeBackfillControl } from "@/features/admin/stripe-backfill-control";
import { TapBackfillControl } from "@/features/admin/tap-backfill-control";
import { HubSpotBackfillControl } from "@/features/admin/hubspot-backfill-control";

const summaries = [
  { provider: "stripe", status: "completed", totalProcessed: 230, totalFailed: 0, completedAt: "2026-08-16T12:00:00.000Z", safeErrorSummary: null },
  { provider: "tap", status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null },
  { provider: "hubspot", status: "failed", totalProcessed: 51, totalFailed: 2, completedAt: null, safeErrorSummary: "Safe source error." },
];

afterEach(() => vi.unstubAllGlobals());

describe("IntegrationRunSummary", () => {
  it("renders saved local totals and reloads them when its refresh token changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ summaries }) });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<IntegrationRunSummary refreshToken={0} />);

    expect(await screen.findByText("Stripe")).toBeInTheDocument();
    expect(screen.getByText(/230 processed/)).toBeInTheDocument();
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getByText("Safe source error.")).toBeInTheDocument();

    view.rerender(<IntegrationRunSummary refreshToken={1} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/admin/integrations/backfill-status", { cache: "no-store" });
  });

  it("uses a generic message when saved run history cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "sensitive backend detail" }) }));

    render(<IntegrationRunSummary refreshToken={0} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Saved run history could not be loaded.");
    expect(screen.queryByText("sensitive backend detail")).not.toBeInTheDocument();
  });

  it("keeps a pending saved run visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ summaries: [
      { provider: "stripe", status: "pending", totalProcessed: 0, totalFailed: 0, completedAt: null, safeErrorSummary: null },
      { provider: "tap", status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null },
      { provider: "hubspot", status: "not_started", totalProcessed: null, totalFailed: null, completedAt: null, safeErrorSummary: null },
    ] }) }));

    render(<IntegrationRunSummary refreshToken={0} />);

    expect(await screen.findByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("0 processed · 0 flagged")).toBeInTheDocument();
  });
});

describe("historical backfill controls", () => {
  it("notifies the shared summary after Stripe, Tap, and HubSpot imports settle", async () => {
    const onRunSettled = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ runId: "11111111-1111-4111-8111-111111111111", processed: 2, failed: 0, totalProcessed: 2, totalFailed: 0, hasMore: false }),
    }));

    const stripe = render(<StripeBackfillControl onRunSettled={onRunSettled} />);
    fireEvent.click(stripe.getByRole("button", { name: "Start or restart historical Stripe import" }));
    await waitFor(() => expect(onRunSettled).toHaveBeenCalledTimes(1));
    stripe.unmount();

    const tap = render(<TapBackfillControl onRunSettled={onRunSettled} />);
    fireEvent.click(tap.getByRole("button", { name: "Start or resume historical Tap import" }));
    await waitFor(() => expect(onRunSettled).toHaveBeenCalledTimes(2));
    tap.unmount();

    const hubspot = render(<HubSpotBackfillControl onRunSettled={onRunSettled} />);
    fireEvent.click(hubspot.getByRole("button", { name: "Start or restart historical backfill" }));
    await waitFor(() => expect(onRunSettled).toHaveBeenCalledTimes(3));
  });
});
