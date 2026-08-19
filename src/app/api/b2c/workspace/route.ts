import { NextRequest, NextResponse } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cWorkspaceLedgerQuerySchema } from "@/lib/validation/b2c-workspace-contracts";
import { SupabaseB2cLedgerRepository, type B2cDecoratedLedgerRow, type B2cLedgerPage } from "@/server/repositories/b2c-ledger-repository";
import { SupabaseB2cWorkspaceRepository } from "@/server/repositories/b2c-workspace-repository";

/** The Work queue and Ready-to-post panel are Admin-only surfaces; a Viewer never receives them. */
type SafeLedgerRow = Omit<B2cDecoratedLedgerRow, "stripeEvidence">;
type SafeLedgerPage = Omit<B2cLedgerPage, "rows"> & { rows: SafeLedgerRow[] };

function validationErrorMessage(issue: { path: PropertyKey[]; message: string } | undefined): string {
  if (!issue) return "Invalid B2C workspace filters.";
  return `${String(issue.path[0] ?? "Workspace")}: ${issue.message}`;
}

/**
 * Admin-only source contacts or provider evidence never leave this route --
 * they stay behind the existing Admin authorization boundaries (the shared
 * record drawer's dedicated evidence reads). Every other field here already
 * renders in the existing Viewer-visible B2C ledger.
 */
function toSafeLedgerRow(row: B2cDecoratedLedgerRow): SafeLedgerRow {
  const { stripeEvidence: _stripeEvidence, ...safeRow } = row;
  return safeRow;
}

export async function GET(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Approved access is required." }, { status: 403 });

  const role = await getApprovedRole(client, user.id);
  if (!role) return NextResponse.json({ error: "Approved access is required." }, { status: 403 });

  const parsed = b2cWorkspaceLedgerQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: validationErrorMessage(parsed.error.issues[0]) }, { status: 422 });

  try {
    const page = await new SupabaseB2cLedgerRepository(client).page(parsed.data);
    const ledger: SafeLedgerPage = { ...page, rows: page.rows.map(toSafeLedgerRow) };
    const workItems = role === "admin" ? (await new SupabaseB2cWorkspaceRepository(client).overview()) : null;
    return NextResponse.json({ role, ledger, workItems });
  } catch {
    return NextResponse.json({ error: "Could not load the B2C workspace." }, { status: 500 });
  }
}
