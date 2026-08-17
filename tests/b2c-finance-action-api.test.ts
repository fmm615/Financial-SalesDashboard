import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/b2c/finance-actions/duplicates/bulk-canonical/route";
import { GET } from "@/app/api/admin/b2c/finance-actions/route";
import { POST as applyDateAuthority } from "@/app/api/admin/b2c/finance-actions/date-authority/route";
import { POST as applyCorrection } from "@/app/api/admin/b2c/finance-actions/[rowId]/correction/route";
import { POST as applySelectedDuplicateDecisions } from "@/app/api/admin/b2c/finance-actions/duplicates/selected/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const adminUser = { id: "11111111-1111-4111-8111-111111111111" };
const groupIds = ["22222222-2222-4222-8222-222222222222"];
const selectedDecisions = [{ groupId: groupIds[0], financeRowId: "33333333-3333-4333-8333-333333333333" }];

describe("bulk B2C Finance duplicate decision API", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a bulk decision without a meaningful reason", async () => {
    const rpc = vi.fn();
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await POST(new NextRequest("http://localhost/api/admin/b2c/finance-actions/duplicates/bulk-canonical", {
      method: "POST",
      body: JSON.stringify({ groupIds, sourceTab: "B2C Cons", reason: "" }),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Enter a reason between 3 and 1000 characters." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks the protected database function to save one auditable decision per eligible group", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await POST(new NextRequest("http://localhost/api/admin/b2c/finance-actions/duplicates/bulk-canonical", {
      method: "POST",
      body: JSON.stringify({ groupIds, sourceTab: "B2C Cons", reason: "B2C Cons contains the fuller verified contact record." }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ decidedGroups: 1 });
    expect(rpc).toHaveBeenCalledWith("apply_b2c_finance_bulk_canonical_decision", {
      p_group_ids: groupIds,
      p_source_tab: "B2C Cons",
      p_reason: "B2C Cons contains the fuller verified contact record.",
    });
  });

  it("saves the Admin's selected duplicate rows in one audited request", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await applySelectedDuplicateDecisions(new NextRequest("http://localhost/api/admin/b2c/finance-actions/duplicates/selected", {
      method: "POST",
      body: JSON.stringify({ decisions: selectedDecisions, reason: "Finance reviewed the payment details and selected the retained record." }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ decidedGroups: 1 });
    expect(rpc).toHaveBeenCalledWith("apply_b2c_finance_selected_duplicate_decisions", {
      p_decisions: selectedDecisions,
      p_reason: "Finance reviewed the payment details and selected the retained record.",
    });
  });

  it("requires an administrator before loading the Finance actions overview", async () => {
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } } as never);

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
  });

  it("rejects a Date-authority action without a meaningful reason", async () => {
    const rpc = vi.fn();
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await applyDateAuthority(new NextRequest("http://localhost/api/admin/b2c/finance-actions/date-authority", {
      method: "POST",
      body: JSON.stringify({ financeRowIds: groupIds, reason: "" }),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Enter a reason between 3 and 1000 characters." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid Finance row before attempting a correction", async () => {
    const rpc = vi.fn();
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await applyCorrection(new NextRequest("http://localhost/api/admin/b2c/finance-actions/not-a-uuid/correction", {
      method: "POST",
      body: JSON.stringify({ customerName: "Verified member", reason: "Finance checked the original signed record." }),
    }), { params: Promise.resolve({ rowId: "not-a-uuid" }) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Invalid B2C Finance row." });
    expect(rpc).not.toHaveBeenCalled();
  });
});
