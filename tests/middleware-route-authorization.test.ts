import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as recordOperationalProgress } from "@/app/api/admin/targets/operational/[targetId]/progress/route";
import { GET as reconcileHubSpot } from "@/app/api/internal/reconcile/hubspot/route";
import { GET as reconcileStripe } from "@/app/api/internal/reconcile/stripe/route";
import { GET as reconcileTap } from "@/app/api/internal/reconcile/tap/route";
import { POST as processReports } from "@/app/api/internal/reports/process/route";
import { POST as receiveHubSpotWebhook } from "@/app/api/webhooks/hubspot/route";
import { POST as receiveStripeWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as receiveTapWebhook } from "@/app/api/webhooks/tap/route";
import { middleware } from "@/middleware";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createServiceDatabaseClient: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  getApprovedRole: vi.fn(),
  getSessionUser: vi.fn(),
  recordOperationalProgress: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServiceDatabaseClient: mocks.createServiceDatabaseClient,
}));
vi.mock("@/lib/auth/access", () => ({
  getApprovedRole: mocks.getApprovedRole,
  getSessionUser: mocks.getSessionUser,
}));
vi.mock("@/server/services/target-management", () => ({
  recordOperationalProgress: mocks.recordOperationalProgress,
}));

const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalSupabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const originalIntegrationSecret = process.env.INTEGRATION_CRON_SECRET;
const originalReportSecret = process.env.REPORT_JOB_CRON_SECRET;
const admin = { id: "11111111-1111-4111-8111-111111111111", email: "admin@playbook.test" };
const viewer = { id: "44444444-4444-4444-8444-444444444444", email: "viewer@playbook.test" };
const targetId = "55555555-5555-4555-8555-555555555555";

function forwardedHeaders(original: NextRequest, response: NextResponse): Headers {
  const headers = new Headers(original.headers);
  const overridden = response.headers.get("x-middleware-override-headers")
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean) ?? [];

  for (const name of overridden) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

async function dispatchProgress(
  incoming: NextRequest,
  changeForwardedHeaders?: (headers: Headers) => void,
) {
  const middlewareResponse = await middleware(incoming);
  if (middlewareResponse.headers.get("x-middleware-next") !== "1") {
    return { middlewareResponse, routeResponse: null, requestHeaders: null };
  }

  const requestHeaders = forwardedHeaders(incoming, middlewareResponse);
  changeForwardedHeaders?.(requestHeaders);
  const routeRequest = new NextRequest(incoming.url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      actualValue: "42",
      effectiveOn: "2027-01-31",
      evidenceNote: "Verified operations export.",
    }),
  });
  const routeResponse = await recordOperationalProgress(routeRequest, {
    params: Promise.resolve({ targetId }),
  });
  return { middlewareResponse, routeResponse, requestHeaders };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  process.env.INTEGRATION_CRON_SECRET = "integration-test-secret";
  process.env.REPORT_JOB_CRON_SECRET = "report-test-secret";
  mocks.createServerClient.mockReturnValue({});
  mocks.createServerSupabaseClient.mockResolvedValue({});
});

afterAll(() => {
  if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalSupabaseKey;
  if (originalIntegrationSecret === undefined) delete process.env.INTEGRATION_CRON_SECRET;
  else process.env.INTEGRATION_CRON_SECRET = originalIntegrationSecret;
  if (originalReportSecret === undefined) delete process.env.REPORT_JOB_CRON_SECRET;
  else process.env.REPORT_JOB_CRON_SECRET = originalReportSecret;
});

describe("middleware-to-route role forwarding", () => {
  it("does not forward an anonymous request even when it forges the Admin header", async () => {
    mocks.getSessionUser.mockResolvedValue({ data: { user: null }, error: null });
    const incoming = new NextRequest(`http://localhost/api/admin/targets/operational/${targetId}/progress`, {
      method: "POST",
      headers: { "x-playbook-role": "admin" },
    });

    const result = await dispatchProgress(incoming);

    expect(result.routeResponse).toBeNull();
    expect(result.middlewareResponse.headers.get("location")).toBe("http://localhost/login");
    expect(mocks.getApprovedRole).not.toHaveBeenCalled();
    expect(mocks.recordOperationalProgress).not.toHaveBeenCalled();
  });

  it("overwrites a real Viewer's forged Admin header before the Admin route rejects it", async () => {
    mocks.getSessionUser.mockResolvedValue({ data: { user: viewer }, error: null });
    mocks.getApprovedRole.mockResolvedValue("viewer");
    const incoming = new NextRequest(`http://localhost/api/admin/targets/operational/${targetId}/progress`, {
      method: "POST",
      headers: { "x-playbook-role": "admin" },
    });

    const result = await dispatchProgress(incoming);

    expect(result.requestHeaders?.get("x-playbook-role")).toBe("viewer");
    expect(result.routeResponse?.status).toBe(403);
    await expect(result.routeResponse?.json()).resolves.toEqual({ error: "Admin access is required." });
    expect(mocks.getApprovedRole).toHaveBeenCalledTimes(1);
    expect(mocks.recordOperationalProgress).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["invalid", "administrator"],
  ])("fails closed when the forwarded role header is %s", async (_label, role) => {
    mocks.getSessionUser.mockResolvedValue({ data: { user: admin }, error: null });
    mocks.getApprovedRole.mockResolvedValue("admin");
    const incoming = new NextRequest(`http://localhost/api/admin/targets/operational/${targetId}/progress`, {
      method: "POST",
    });

    const result = await dispatchProgress(incoming, (headers) => {
      if (role === null) headers.delete("x-playbook-role");
      else headers.set("x-playbook-role", role);
    });

    expect(result.routeResponse?.status).toBe(403);
    expect(mocks.getApprovedRole).toHaveBeenCalledTimes(1);
    expect(mocks.recordOperationalProgress).not.toHaveBeenCalled();
  });

  it("rejects a signed-in user whose approved-role lookup is disabled", async () => {
    mocks.getSessionUser.mockResolvedValue({ data: { user: viewer }, error: null });
    mocks.getApprovedRole.mockResolvedValue(null);
    const incoming = new NextRequest(`http://localhost/api/admin/targets/operational/${targetId}/progress`, {
      method: "POST",
      headers: { "x-playbook-role": "admin" },
    });

    const result = await dispatchProgress(incoming);

    expect(result.routeResponse).toBeNull();
    expect(result.middlewareResponse.headers.get("location")).toBe("http://localhost/access-denied");
    expect(mocks.recordOperationalProgress).not.toHaveBeenCalled();
  });
});

describe("middleware role trust boundaries", () => {
  const independentlyAuthenticatedRoutes = [
    { path: "api/internal/reconcile/hubspot", method: "GET", handler: reconcileHubSpot },
    { path: "api/internal/reconcile/stripe", method: "GET", handler: reconcileStripe },
    { path: "api/internal/reconcile/tap", method: "GET", handler: reconcileTap },
    { path: "api/internal/reports/process", method: "POST", handler: processReports },
    { path: "api/webhooks/hubspot", method: "POST", handler: receiveHubSpotWebhook },
    { path: "api/webhooks/stripe", method: "POST", handler: receiveStripeWebhook },
    { path: "api/webhooks/tap", method: "POST", handler: receiveTapWebhook },
  ];

  it.each(independentlyAuthenticatedRoutes)("leaves /$path outside session middleware and the role helper", async ({ path: routePath, method, handler }) => {
    const incoming = new NextRequest(`http://localhost/${routePath}`, {
      method,
      headers: { "content-type": "application/json", "x-playbook-role": "admin" },
      body: method === "POST" ? "{}" : undefined,
    });
    const middlewareResponse = await middleware(incoming);
    const handlerRequest = new NextRequest(incoming.url, {
      method,
      headers: forwardedHeaders(incoming, middlewareResponse),
      body: method === "POST" ? "{}" : undefined,
    });
    const routeResponse = await handler(handlerRequest);
    const source = readFileSync(path.join(process.cwd(), "src/app", routePath, "route.ts"), "utf8");

    expect(middlewareResponse.headers.get("x-middleware-next")).toBe("1");
    expect(middlewareResponse.headers.get("x-middleware-request-x-playbook-role")).toBeNull();
    expect([401, 503]).toContain(routeResponse.status);
    expect(source).not.toContain("requireMiddlewareRole");
    expect(source).not.toContain("@/lib/auth/middleware-role");
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getApprovedRole).not.toHaveBeenCalled();
    expect(mocks.createServiceDatabaseClient).not.toHaveBeenCalled();
  });

  it("keeps direct database role authorization on every user-triggered service-role route", () => {
    const serviceRoleRoutes = [
      "api/admin/hubspot/backfill",
      "api/admin/stripe/backfill",
      "api/admin/tap/backfill",
      "api/integrations/hubspot/sync",
      "api/integrations/stripe/sync",
      "api/integrations/tap/sync",
    ];

    for (const routePath of serviceRoleRoutes) {
      const source = readFileSync(path.join(process.cwd(), "src/app", routePath, "route.ts"), "utf8");
      expect(source).toContain("getApprovedRole");
      expect(source).toContain("createServiceDatabaseClient");
      expect(source).not.toContain("requireMiddlewareRole");
    }
  });
});
