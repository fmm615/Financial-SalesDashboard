"use client";

import { useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (signInError) setError("Google sign-in could not start. Check the Supabase provider configuration.");
    } catch {
      setError("Supabase is not configured for this environment.");
    } finally {
      setLoading(false);
    }
  }

  return <><button type="button" onClick={signInWithGoogle} disabled={loading} className="mt-8 w-full rounded-pill bg-brand-lime px-4 py-3 text-sm font-semibold text-brand-primary shadow-cta hover:bg-brand-lime-hover disabled:cursor-wait disabled:opacity-60">{loading ? "Redirecting to Google…" : "Continue with Google"}</button>{error && <p role="alert" className="mt-4 text-sm leading-6 text-danger">{error}</p>}</>;
}
