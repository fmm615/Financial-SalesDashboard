import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { b2cDuplicateDetectionWindowSchema } from "@/lib/validation/b2c-settings-contracts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Reads the current B2C duplicate-detection window (public.b2c_settings). Admin-only, like every route under /api/admin/**. */
export async function GET(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || requireMiddlewareRole(request) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const { data, error } = await client
    .from("b2c_settings")
    .select("duplicate_detection_window_hours,reason,updated_by,updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Could not load B2C settings." }, { status: 500 });
  return NextResponse.json({
    windowHours: data.duplicate_detection_window_hours,
    reason: data.reason,
    updatedBy: data.updated_by,
    updatedAt: data.updated_at,
  });
}

/**
 * Changes the B2C duplicate-detection window through the protected RPC
 * (update_b2c_duplicate_detection_window,
 * supabase/migrations/20270101000700_b2c_duplicate_window_setting.sql), which
 * independently re-verifies Admin access, bounds, and the reason, and records
 * the change in audit_events. This route's own Admin check is defense in
 * depth, matching every other route under /api/admin/**.
 */
export async function POST(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || requireMiddlewareRole(request) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const parsed = b2cDuplicateDetectionWindowSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid B2C duplicate-detection window." }, { status: 422 });

  const { error } = await client.rpc("update_b2c_duplicate_detection_window", {
    p_window_hours: parsed.data.windowHours,
    p_reason: parsed.data.reason,
  });
  if (error) return NextResponse.json({ error: "The B2C duplicate-detection window could not be changed." }, { status: 422 });
  return NextResponse.json({ windowHours: parsed.data.windowHours }, { status: 200 });
}
