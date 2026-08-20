import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/b2c/finance-actions/route";
import { POST as applyDateAuthority } from "@/app/api/admin/b2c/finance-actions/date-authority/route";
import { POST as applyCorrection } from "@/app/api/admin/b2c/finance-actions/[rowId]/correction/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const adminUser = { id: "11111111-1111-4111-8111-111111111111" };
const groupIds = ["22222222-2222-4222-8222-222222222222"];

/**
 * The bulk canonical-decision and selected-duplicate-decision routes (and
 * their bulk-canonical UI trigger) were removed in Task 7: Task 1's
 * automatic exact-duplicate grouping plus the drawer's one-group
 * `/api/admin/b2c/reconciliation/[groupId]/decision` route are the sole
 * duplicate write path (see tests/b2c-payment-duplicate-drawer.test.tsx and
 * tests/b2c-exact-duplicate-reconciliation-api.test.ts).
 *
 * The Date-authority and row-correction routes below are kept: they still
 * work and are still tested, but no live feature component calls either of
 * them any more -- their only callers were the data-quality/duplicate
 * action components deleted in Task 7. `date-authority` resolves a
 * `declared_month_conflicts_with_date`/`declared_year_conflicts_with_date`
 * staging-row quality issue distinct from correcting an already-ledgered
 * payment; Task 5 left it "untouched" rather than wiring it into the new
 * drawer. This is a known, documented gap, not something to fix here.
 */
describe("B2C Finance action API", () => {
  beforeEach(() => vi.resetAllMocks());

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
