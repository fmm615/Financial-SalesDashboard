import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

export type DatabaseClient = SupabaseClient<Database>;

/**
 * Creates a request-scoped client for an already authenticated Supabase user.
 * Admin writes must use this client so RLS and audit triggers receive auth.uid().
 */
export function createAuthenticatedDatabaseClient(accessToken: string): DatabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) {
    throw new Error("Supabase public configuration is missing.");
  }

  return createClient<Database>(url, publishableKey, {
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
