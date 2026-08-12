import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listGroups } from "@/app/api/admin/b2c/reconciliation/exact-duplicates/route";
import { POST as createGroups } from "@/app/api/admin/b2c/reconciliation/exact-duplicates/group/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const adminUser = { id: "11111111-1111-4111-8111-111111111111" };

describe("B2C exact duplicate reconciliation APIs", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a Viewer before creating duplicate groups", async () => {
    const rpc = vi.fn();
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("viewer");

    const response = await createGroups(new NextRequest("http://localhost/api/admin/b2c/reconciliation/exact-duplicates/group", { method: "POST" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin access is required." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks the protected database function to create groups for an Admin", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 2, error: null });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, rpc } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await createGroups(new NextRequest("http://localhost/api/admin/b2c/reconciliation/exact-duplicates/group", { method: "POST" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ createdGroups: 2 });
    expect(rpc).toHaveBeenCalledWith("create_b2c_exact_duplicate_groups", {});
  });

  it("returns only two selected Finance rows to an Admin reviewer", async () => {
    const groupRows = [{
      id: "22222222-2222-4222-8222-222222222222", reconciliation_state: "exact_duplicate_candidate",
      b2c_reconciliation_finance_rows: [
        { finance_row_id: "33333333-3333-4333-8333-333333333333", b2c_finance_staging_rows: { source_tab: "B2C", source_row_number: 12, occurred_on: "2025-10-05", amount_usd: "475", customer_name_raw: "Reham", customer_email_raw: "rgarash@example.com", customer_phone_raw: null, category_raw: "B2C-Membership", payment_method_raw: "Stripe", raw_payload: { private: true } } },
        { finance_row_id: "44444444-4444-4444-8444-444444444444", b2c_finance_staging_rows: { source_tab: "B2C Cons", source_row_number: 33, occurred_on: "2025-10-05", amount_usd: "475", customer_name_raw: "Reham", customer_email_raw: "rgarash@example.com", customer_phone_raw: null, category_raw: "B2C-Membership", payment_method_raw: "Stripe", raw_payload: { private: true } } },
      ],
    }];
    const eq = vi.fn().mockResolvedValue({ data: groupRows, error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, from } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await listGroups();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ groups: [{
      groupId: "22222222-2222-4222-8222-222222222222", state: "exact_duplicate_candidate", rows: [
        { financeRowId: "33333333-3333-4333-8333-333333333333", sourceTab: "B2C", sourceRowNumber: 12, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
        { financeRowId: "44444444-4444-4444-8444-444444444444", sourceTab: "B2C Cons", sourceRowNumber: 33, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
      ],
    }] });
  });
});
