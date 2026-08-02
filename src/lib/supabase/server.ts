import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/types/database.generated";

export type DatabaseClient = SupabaseClient<Database>;

function getPublicSupabaseConfig(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase public configuration is missing.");
  return { url, key };
}

/** Server Component/Route Handler client backed by the Supabase Auth cookie session. */
export async function createServerSupabaseClient(): Promise<DatabaseClient> {
  const { url, key } = getPublicSupabaseConfig();
  const cookieStore = await cookies();
  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(values) {
        try {
          values.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies. Middleware refreshes the session.
        }
      },
    },
  });
}

/**
 * Creates a request-scoped client for an already authenticated Supabase user.
 * Admin writes must use this client so RLS and audit triggers receive auth.uid().
 */
export function createAuthenticatedDatabaseClient(accessToken: string): DatabaseClient {
  const { url, key } = getPublicSupabaseConfig();

  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * For trusted server jobs only. It bypasses RLS and therefore must not process
 * user-initiated Admin actions or be imported into browser code.
 */
export function createServiceDatabaseClient(): DatabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase server configuration is missing.");
  }
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
