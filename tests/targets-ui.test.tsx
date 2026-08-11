import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleProvider } from "@/lib/auth/role-context";
import { TargetManagementPage } from "@/features/targets/target-management-page";

vi.mock("next/navigation", () => ({ usePathname: () => "/finance/targets" }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

function targetResponse() {
  return {
    financialTargets: [],
    operationalTargets: [{
      id: "11111111-1111-4111-8111-111111111111",
      display_name: "Summit tickets",
      value_kind: "quantity",
      target_value: "100",
      unit_label: "tickets",
      period_start: "2026-01-01",
      period_end: "2026-12-31",
      finance_reference: "Summit plan",
    }],
    operationalProgressUpdates: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("target management UI", () => {
  it("lets an Admin revise an operational target without overwriting it in the browser", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/revise")) return { ok: true, json: async () => ({ targetId: "22222222-2222-4222-8222-222222222222" }) };
      return { ok: true, json: async () => targetResponse() };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RoleProvider role="admin"><TargetManagementPage /></RoleProvider>);

    await screen.findByText("Summit tickets");
    fireEvent.click(screen.getByRole("button", { name: "Revise target" }));
    const form = screen.getByRole("form", { name: "Revise operational target" });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Revised Summit tickets" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Goal" }), { target: { value: "125" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Revision reason" }), { target: { value: "Finance approved revision" } });
    fireEvent.submit(form);

    await screen.findByText("Summit tickets");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/targets/operational/11111111-1111-4111-8111-111111111111/revise",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByRole("form", { name: "Revise operational target" })).not.toBeInTheDocument();
  });
});
