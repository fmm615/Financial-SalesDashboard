import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRole } from "@/lib/auth/role-context";
import { retryTransient } from "@/lib/resilience";
import type { Database } from "@/types/database.generated";

/**
 * A network blip on one of this function's 3 sequential queries previously
 * looked identical to "no matching row", so callers everywhere would report
 * the genuinely-approved caller as unauthorized. Retrying on a real query
 * error (never on a real "no row" result, which has no error) absorbs a run
 * of dropped connections before it reaches any caller.
 */
function withRetry<T>(run: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<{ data: T | null; error: unknown }> {
  return retryTransient(run, (result) => Boolean(result.error));
}

/**
 * client.auth.getUser() re-verifies the session against Supabase's auth
 * server on every call. Every route that only read `data.user` and ignored
 * `error` treated a dropped connection on this call as "not signed in",
 * returning a false "access is required" even for a genuinely signed-in
 * user. Retrying on a real error (never on a legitimately empty session,
 * which has no error) absorbs a run of flaky round trips. Callers keep
 * destructuring `const { data: { user } } = await getSessionUser(client);`
 * unchanged -- this returns the same shape client.auth.getUser() does.
 */
export function getSessionUser(client: SupabaseClient<Database>) {
  return retryTransient(() => client.auth.getUser(), (result) => !result.data.user && Boolean(result.error));
}

/**
 * RLS is the authorization authority. This lookup only converts the allowed,
 * authenticated user into an application role for routing and presentation.
 */
export async function getApprovedRole(
  client: SupabaseClient<Database>,
  profileId: string,
): Promise<AppRole | null> {
  const { data: profile } = await withRetry<{ id: string }>(() => client.from("profiles").select("id").eq("id", profileId).maybeSingle());
  if (!profile) return null;

  const { data: assignment } = await withRetry<{ role_id: string }>(() =>
    client.from("profile_roles").select("role_id").eq("profile_id", profileId).maybeSingle(),
  );
  if (!assignment) return null;

  const { data: role } = await withRetry<{ code: "admin" | "viewer" }>(() =>
    client.from("roles").select("code").eq("id", assignment.role_id).maybeSingle(),
  );
  return role?.code === "admin" || role?.code === "viewer" ? role.code : null;
}
