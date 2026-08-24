-- Both protected product-mapping writers recompute a payment's SHA-256
-- duplicate fingerprint with digest(). Supabase installs pgcrypto in the
-- trusted extensions schema, so the fixed SECURITY DEFINER search path must
-- include it. ALTER FUNCTION preserves each function's body, signature,
-- ownership, security mode, and existing execute grants.
alter function public.apply_stripe_product_mapping(text, text, text, text, text, text)
  set search_path = public, extensions;

alter function public.apply_b2c_product_mapping(text, text, text, text, text, text, text)
  set search_path = public, extensions;
