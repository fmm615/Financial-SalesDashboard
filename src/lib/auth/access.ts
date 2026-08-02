import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRole } from "@/lib/auth/role-context";
import type { Database } from "@/types/database.generated";

/**
 * RLS is the authorization authority. This lookup only converts the allowed,
 * authenticated user into an application role for routing and presentation.
 */
export async function getApprovedRole(
  client: SupabaseClient<Database>,
  profileId: string,
): Promise<AppRole | null> {
  const { data: profile } = await client.from("profiles").select("id").eq("id", profileId).maybeSingle();
  if (!profile) return null;

  const { data: assignment } = await client
    .from("profile_roles")
    .select("role_id")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (!assignment) return null;

  const { data: role } = await client.from("roles").select("code").eq("id", assignment.role_id).maybeSingle();
  return role?.code === "admin" || role?.code === "viewer" ? role.code : null;
}
