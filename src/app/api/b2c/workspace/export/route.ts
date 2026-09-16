import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/access";
import { requireMiddlewareRole } from "@/lib/auth/middleware-role";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { b2cWorkspaceLedgerExportQuerySchema } from "@/lib/validation/b2c-workspace-contracts";
import { resolveB2cReportingPeriod } from "@/server/repositories/b2c-dashboard-repository";
import { SupabaseB2cLedgerRepository } from "@/server/repositories/b2c-ledger-repository";
import { buildB2cLedgerCsv } from "@/server/services/export-b2c-ledger";

function validationErrorMessage(issue: { path: PropertyKey[]; message: string } | undefined): string {
  if (!issue) return "Invalid B2C Ledger export filters.";
  return `${String(issue.path[0] ?? "Export")}: ${issue.message}`;
}

export async function GET(request: NextRequest) {
  const client = await createServerSupabaseClient();
  const { data: { user } } = await getSessionUser(client);
  if (!user || requireMiddlewareRole(request) !== "admin") {
    return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  }

  const parsed = b2cWorkspaceLedgerExportQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: validationErrorMessage(parsed.error.issues[0]) }, { status: 422 });
  }

  try {
    const ledgerExport = await new SupabaseB2cLedgerRepository(client).exportRows(parsed.data);
    const period = resolveB2cReportingPeriod(parsed.data.period).month;
    return new NextResponse(buildB2cLedgerCsv(ledgerExport.rows), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="b2c-ledger-${period}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        "X-Playbook-Export-Capped": String(ledgerExport.capped),
        "X-Playbook-Export-Row-Count": String(ledgerExport.rows.length),
        "X-Playbook-Export-Total-Count": String(ledgerExport.totalCount),
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not export the B2C Ledger." }, { status: 500 });
  }
}
