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

type ProfileRoleJoin = { role_id: string; roles: { code: "admin" | "viewer" } | null };

/**
 * RLS is the authorization authority. This lookup only converts the allowed,
 * authenticated user into an application role for routing and presentation.
 *
 * middleware.ts runs this on every single navigation and API call, so its
 * cost multiplies across the whole app. This used to be 3 sequential round
 * trips (profiles -> profile_roles -> roles); the separate `profiles`
 * existence check was redundant (profile_roles.profile_id is itself the
 * primary key and profile_roles.role_id/profile_id are both FK-enforced, so
 * a profile_roles row cannot exist for a nonexistent profile or role), and
 * profile_roles/roles can be read in one PostgREST embedded-resource query
 * since profile_roles.role_id has a foreign key to the unique roles.id. This
 * collapses it to a single round trip.
 */
export async function getApprovedRole(
  client: SupabaseClient<Database>,
  profileId: string,
): Promise<AppRole | null> {
  const { data } = await withRetry<ProfileRoleJoin>(() =>
    client.from("profile_roles").select("role_id, roles(code)").eq("profile_id", profileId).maybeSingle() as unknown as PromiseLike<{ data: ProfileRoleJoin | null; error: unknown }>,
  );
  const code = data?.roles?.code;
  return code === "admin" || code === "viewer" ? code : null;
}
