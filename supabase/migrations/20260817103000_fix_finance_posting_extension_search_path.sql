-- Supabase installs pgcrypto in the extensions schema. The protected Finance
-- posting function uses digest() for a deterministic source-row fingerprint,
-- so its locked search path must include that trusted schema.

alter function public.post_approved_b2c_finance_payments()
  set search_path = public, extensions;
