import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS,
  B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS,
  b2cDuplicateDetectionWindowSchema,
} from "@/lib/validation/b2c-settings-contracts";
import { GET, POST } from "@/app/api/admin/b2c/settings/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SupabaseB2cPaymentsRepository } from "@/server/repositories/b2c-payments-repository";

const middlewareRoleMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ getSessionUser: (client: { auth: { getUser: () => unknown } }) => client.auth.getUser() }));
vi.mock("@/lib/auth/middleware-role", () => ({ requireMiddlewareRole: middlewareRoleMock }));

const createServerClientMock = vi.mocked(createServerSupabaseClient);
const adminUserId = "11111111-1111-4111-8111-111111111111";

function jsonRequest(method: "GET" | "POST", url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json" },
  });
}

function chainable(resolveWith: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(resolveWith);
  return builder;
}

function mockClient(overrides: { from?: ReturnType<typeof vi.fn>; rpc?: ReturnType<typeof vi.fn> } = {}) {
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: adminUserId } } }) },
    from: overrides.from ?? vi.fn(),
    rpc: overrides.rpc ?? vi.fn(),
  };
  createServerClientMock.mockResolvedValue(client as never);
  return client;
}

/**
 * Bounds mirror the database check constraint on
 * public.b2c_settings.duplicate_detection_window_hours and the
 * update_b2c_duplicate_detection_window RPC
 * (supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql):
 * 1-168 hours. See that migration and this schema's own comment for why.
 */
describe("b2cDuplicateDetectionWindowSchema", () => {
  it("accepts the documented default and both boundary values", () => {
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: 48, reason: "Restoring the documented default." }).success).toBe(true);
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: B2C_DUPLICATE_DETECTION_WINDOW_MIN_HOURS, reason: "Narrowing to the minimum." }).success).toBe(true);
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS, reason: "Widening to the maximum." }).success).toBe(true);
  });

  it("rejects zero, negative, non-integer, and above-maximum windows", () => {
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: 0, reason: "Too small." }).success).toBe(false);
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: -5, reason: "Negative." }).success).toBe(false);
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: 12.5, reason: "Fractional." }).success).toBe(false);
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: B2C_DUPLICATE_DETECTION_WINDOW_MAX_HOURS + 1, reason: "Too large." }).success).toBe(false);
  });

  it("rejects a missing or too-short reason", () => {
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: 48 }).success).toBe(false);
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: 48, reason: "ok" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(b2cDuplicateDetectionWindowSchema.safeParse({ windowHours: 48, reason: "Valid reason text.", extra: true }).success).toBe(false);
  });
});

describe("GET /api/admin/b2c/settings", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a Viewer", async () => {
    mockClient();
    middlewareRoleMock.mockReturnValue("viewer");

    const response = await GET(jsonRequest("GET", "http://localhost/api/admin/b2c/settings"));

    expect(response.status).toBe(403);
  });

  it("returns the current window for an Admin", async () => {
    middlewareRoleMock.mockReturnValue("admin");
    mockClient({
      from: vi.fn().mockReturnValue(chainable({
        data: { duplicate_detection_window_hours: 48, reason: null, updated_by: null, updated_at: "2027-01-01T00:00:00Z" },
        error: null,
      })),
    });

    const response = await GET(jsonRequest("GET", "http://localhost/api/admin/b2c/settings"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ windowHours: 48 });
  });
});

describe("POST /api/admin/b2c/settings", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a Viewer before calling the RPC", async () => {
    const rpc = vi.fn();
    middlewareRoleMock.mockReturnValue("viewer");
    mockClient({ rpc });

    const response = await POST(jsonRequest("POST", "http://localhost/api/admin/b2c/settings", { windowHours: 72, reason: "Viewer attempt." }));

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an out-of-bounds window before calling the RPC", async () => {
    const rpc = vi.fn();
    middlewareRoleMock.mockReturnValue("admin");
    mockClient({ rpc });

    const response = await POST(jsonRequest("POST", "http://localhost/api/admin/b2c/settings", { windowHours: 0, reason: "Too small." }));

    expect(response.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls the protected RPC with the Admin's window and reason", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    middlewareRoleMock.mockReturnValue("admin");
    mockClient({ rpc });

    const response = await POST(jsonRequest("POST", "http://localhost/api/admin/b2c/settings", { windowHours: 72, reason: "Finance requested a wider review window." }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("update_b2c_duplicate_detection_window", {
      p_window_hours: 72,
      p_reason: "Finance requested a wider review window.",
    });
  });

  it("surfaces a 422 (not a raw database error) when the RPC rejects the change", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "duplicate_detection_window_hours check constraint" } });
    middlewareRoleMock.mockReturnValue("admin");
    mockClient({ rpc });

    const response = await POST(jsonRequest("POST", "http://localhost/api/admin/b2c/settings", { windowHours: 72, reason: "Finance requested a wider review window." }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: expect.not.stringContaining("constraint") });
  });
});

describe("SupabaseB2cPaymentsRepository reads the configured window (not a hardcoded 48 hours)", () => {
  it("queries public.b2c_settings for the current duplicate-detection window", async () => {
    const settingsFrom = vi.fn().mockReturnValue(chainable({ data: { duplicate_detection_window_hours: 12 }, error: null }));
    const paymentsBuilder: Record<string, unknown> = {};
    paymentsBuilder.select = vi.fn().mockReturnValue(paymentsBuilder);
    paymentsBuilder.eq = vi.fn().mockReturnValue(paymentsBuilder);
    paymentsBuilder.gte = vi.fn().mockReturnValue(paymentsBuilder);
    paymentsBuilder.lte = vi.fn().mockReturnValue(paymentsBuilder);
    paymentsBuilder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    paymentsBuilder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });

    const client = {
      from: vi.fn((table: string) => (table === "b2c_settings" ? settingsFrom(table) : paymentsBuilder)),
    };
    const repository = new SupabaseB2cPaymentsRepository(client as never);

    await repository.assessManualBankTransferDuplicates({
      bankReference: "IBAN-TEST",
      customerEmail: "member@playbook.test",
      customerName: "Ada Founder",
      membershipTier: null,
      amountUsd: "100.000000",
      receivedAtRaw: "2027-01-05T08:00:00+03:00",
      occurredOn: "2027-01-05",
      reason: "Test transfer.",
    });

    expect(client.from).toHaveBeenCalledWith("b2c_settings");
  });
});
