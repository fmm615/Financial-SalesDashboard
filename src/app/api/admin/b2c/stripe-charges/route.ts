import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { StripeChargesEvidenceRepository } from "@/server/repositories/stripe-charges-evidence-repository";
import { toAdminStripeEvidenceRecord } from "@/server/services/stripe-charges-evidence";
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50) });
export async function GET(request: NextRequest) { const client = await createServerSupabaseClient(); const { data: { user } } = await client.auth.getUser(); if (!user || await getApprovedRole(client, user.id) !== "admin") return NextResponse.json({ error: "Admin access is required." }, { status: 403 }); const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams)); if (!parsed.success) return NextResponse.json({ error: "The Stripe review limit must be between 1 and 50." }, { status: 422 }); try { return NextResponse.json({ records: (await new StripeChargesEvidenceRepository(client).listCompleted(parsed.data.limit)).map(toAdminStripeEvidenceRecord) }); } catch { return NextResponse.json({ error: "Could not load staged Stripe Charges evidence." }, { status: 500 }); } }
