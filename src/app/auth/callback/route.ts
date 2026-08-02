import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/executive";
  redirectUrl.search = "";

  if (!code) {
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("error", "missing_code");
    return NextResponse.redirect(redirectUrl);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("error", "sign_in_failed");
    }
  } catch {
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("error", "configuration");
  }
  return NextResponse.redirect(redirectUrl);
}
