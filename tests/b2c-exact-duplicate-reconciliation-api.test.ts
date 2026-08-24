import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as listGroups } from "@/app/api/admin/b2c/reconciliation/exact-duplicates/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getApprovedRole } from "@/lib/auth/access";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getApprovedRole: vi.fn() }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const getApprovedRoleMock = vi.mocked(getApprovedRole);
const adminUser = { id: "11111111-1111-4111-8111-111111111111" };

/**
 * The manual "Find exact duplicates" creation trigger (and its
 * `POST .../exact-duplicates/group` route) was removed: Task 1's
 * `create_b2c_exact_duplicate_groups()` already runs automatically inside
 * `finalize_b2c_finance_import_version`, so a second, manual discovery
 * action would violate "no bulk shortcut, one owning action" (see the plan's
 * "Remove" list). Only the read-only listing this drawer's duplicate-review
 * fragment depends on remains live.
 */
describe("B2C exact duplicate reconciliation APIs", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only two selected Finance rows to an Admin reviewer", async () => {
    const groupRows = [{
      id: "22222222-2222-4222-8222-222222222222", reconciliation_state: "exact_duplicate_candidate",
      b2c_reconciliation_finance_rows: [
        { finance_row_id: "33333333-3333-4333-8333-333333333333", b2c_finance_staging_rows: { source_tab: "B2C", source_row_number: 12, occurred_on: "2025-10-05", amount_usd: "475", customer_name_raw: "Reham", customer_email_raw: "rgarash@example.com", customer_phone_raw: null, category_raw: "B2C-Membership", payment_method_raw: "Stripe", raw_payload: { private: true } } },
        { finance_row_id: "44444444-4444-4444-8444-444444444444", b2c_finance_staging_rows: { source_tab: "B2C Cons", source_row_number: 33, occurred_on: "2025-10-05", amount_usd: "475", customer_name_raw: "Reham", customer_email_raw: "rgarash@example.com", customer_phone_raw: null, category_raw: "B2C-Membership", payment_method_raw: "Stripe", raw_payload: { private: true } } },
      ],
    }];
    const range = vi.fn().mockResolvedValue({ data: groupRows, error: null });
    const order = vi.fn().mockReturnValue({ range });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, from } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await listGroups(new NextRequest("http://localhost/api/admin/b2c/reconciliation/exact-duplicates"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ groups: [{
      groupId: "22222222-2222-4222-8222-222222222222", state: "exact_duplicate_candidate", rows: [
        { financeRowId: "33333333-3333-4333-8333-333333333333", sourceTab: "B2C", sourceRowNumber: 12, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
        { financeRowId: "44444444-4444-4444-8444-444444444444", sourceTab: "B2C Cons", sourceRowNumber: 33, occurredOn: "2025-10-05", amountUsd: "475", customerName: "Reham", customerEmail: "rgarash@example.com", customerPhone: null, category: "B2C-Membership", paymentMethod: "Stripe" },
      ],
    }] });
  });

  it("rejects an invalid direct group ID before it reads Admin Finance data", async () => {
    const from = vi.fn();
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, from } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await listGroups(new NextRequest("http://localhost/api/admin/b2c/reconciliation/exact-duplicates?groupId=not-a-uuid"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Invalid B2C reconciliation group." });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects an empty direct group ID before it lists unrelated Finance groups", async () => {
    const from = vi.fn();
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, from } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await listGroups(new NextRequest("http://localhost/api/admin/b2c/reconciliation/exact-duplicates?groupId="));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "Invalid B2C reconciliation group." });
    expect(from).not.toHaveBeenCalled();
  });

  it("uses a direct group query for a Finance duplicate deep link", async () => {
    const groupId = "22222222-2222-4222-8222-222222222222";
    const group = {
      id: groupId,
      reconciliation_state: "exact_duplicate_candidate",
      b2c_reconciliation_finance_rows: [],
    };
    const maybeSingle = vi.fn().mockResolvedValue({ data: group, error: null });
    const stateEq = vi.fn().mockReturnValue({ maybeSingle });
    const idEq = vi.fn().mockReturnValue({ eq: stateEq });
    const select = vi.fn().mockReturnValue({ eq: idEq });
    const from = vi.fn().mockReturnValue({ select });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, from } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    await listGroups(new NextRequest(`http://localhost/api/admin/b2c/reconciliation/exact-duplicates?groupId=${groupId}`));

    expect(idEq).toHaveBeenCalledWith("id", groupId);
    expect(stateEq).toHaveBeenCalledWith("reconciliation_state", "exact_duplicate_candidate");
    expect(maybeSingle).toHaveBeenCalledOnce();
  });

  it("pages exact duplicate groups deterministically so a 501st group is not dropped", async () => {
    const groups = Array.from({ length: 501 }, (_, index) => ({
      id: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`,
      reconciliation_state: "exact_duplicate_candidate" as const,
      b2c_reconciliation_finance_rows: [
        { finance_row_id: `${String(index).padStart(8, "0")}-3333-4333-8333-333333333333`, b2c_finance_staging_rows: { source_tab: "B2C" as const, source_row_number: 12, occurred_on: "2026-08-01", amount_usd: "100.000000", customer_name_raw: "Maya Al Khalifa", customer_email_raw: "member@example.com", customer_phone_raw: null, category_raw: "membership", payment_method_raw: "Stripe" } },
        { finance_row_id: `${String(index).padStart(8, "0")}-4444-4444-8444-444444444444`, b2c_finance_staging_rows: { source_tab: "B2C Cons" as const, source_row_number: 33, occurred_on: "2026-08-01", amount_usd: "100.000000", customer_name_raw: "Maya Al Khalifa", customer_email_raw: "member@example.com", customer_phone_raw: null, category_raw: "membership", payment_method_raw: "Stripe" } },
      ],
    }));
    const range = vi.fn(async (start: number, end: number) => ({ data: groups.slice(start, end + 1), error: null }));
    const order = vi.fn().mockReturnValue({ range });
    const query = { order, then: (resolve: (result: { data: typeof groups; error: null }) => unknown) => resolve({ data: groups, error: null }) };
    const eq = vi.fn().mockReturnValue(query);
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    createServerClientMock.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) }, from } as never);
    getApprovedRoleMock.mockResolvedValue("admin");

    const response = await listGroups(new NextRequest("http://localhost/api/admin/b2c/reconciliation/exact-duplicates"));

    expect(range).toHaveBeenNthCalledWith(1, 0, 499);
    expect(range).toHaveBeenNthCalledWith(2, 500, 999);
    expect(response.status).toBe(200);
    const body = await response.json() as { groups: Array<{ groupId: string }> };
    expect(body.groups).toContainEqual(expect.objectContaining({ groupId: groups[500].id }));
  });
});
