import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getApprovedRole } from "@/lib/auth/access";
import type { Database } from "@/types/database.generated";

const PUBLIC_PATHS = new Set(["/login", "/access-denied", "/session-loading"]);
const ADMIN_ONLY_PATHS = new Set(["/admin", "/audit-log"]);

function redirectWithSessionCookies(response: NextResponse, request: NextRequest, path: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  const redirect = NextResponse.redirect(url);
  response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/auth/")) return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return PUBLIC_PATHS.has(pathname) ? NextResponse.next() : redirectWithSessionCookies(NextResponse.next(), request, "/login");
  }

  const requestHeaders = new Headers(request.headers);
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const supabase = createServerClient<Database>(url, key, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(values) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: requestHeaders } });
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return PUBLIC_PATHS.has(pathname) ? response : redirectWithSessionCookies(response, request, "/login");

  const role = await getApprovedRole(supabase, user.id);
  if (!role) {
    return pathname === "/access-denied" ? response : redirectWithSessionCookies(response, request, "/access-denied");
  }

  if (pathname === "/login" || pathname === "/access-denied") return redirectWithSessionCookies(response, request, "/executive");
  if (ADMIN_ONLY_PATHS.has(pathname) && role !== "admin") return redirectWithSessionCookies(response, request, "/access-denied");

  requestHeaders.set("x-playbook-role", role);
  const authorizedResponse = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.getAll().forEach((cookie) => authorizedResponse.cookies.set(cookie));
  return authorizedResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
