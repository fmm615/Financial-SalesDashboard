-- Supabase installs pgcrypto in the extensions schema. The manual bank
-- transfer lineage-reservation trigger uses digest() for a deterministic
-- source-identity hash, so its locked search path must include that trusted
-- schema (same class of defect already fixed for the Finance posting
-- function in 20260817103000_fix_finance_posting_extension_search_path.sql).
-- Without this, every manual bank transfer with a valid customer_name,
-- occurred_on, and amount_usd raises "function digest(text, unknown) does
-- not exist" from the AFTER INSERT trigger, so the RPC that creates it
-- (record_b2c_manual_bank_transfer) always fails.

alter function public.reserve_b2c_finance_manual_bank_transfer_lineage()
  set search_path = public, extensions;
