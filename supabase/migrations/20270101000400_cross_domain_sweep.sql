-- Final cross-cutting sweep migration (clean-slate rebuild). Runs after all
-- four domain migrations (foundation/access, B2B, B2C, finance/targets/
-- reports) since it references public.write_audit_event() from the finance
-- domain migration and attaches it to tables owned by three OTHER domain
-- migrations. Each domain migration already fully owns its own table-specific
-- RLS, policies, and select/insert/update grants -- this file only adds the
-- two things that inherently require every domain's tables to already exist:
-- audit-trigger attachment on the tables not owned by the finance domain, and
-- the baseline schema-usage/anon-revoke safety net.

-- A brand-new `create schema public` (as this clean-slate rebuild does, once,
-- on the very first foundation migration) starts completely bare: nothing,
-- not even `service_role`, has any privilege on it until granted here. Every
-- trusted server job in this app (src/lib/supabase/server.ts's
-- createServiceDatabaseClient) depends on service_role having full access.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;

do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'approved_users', 'profile_roles',
    'customers', 'products', 'product_mappings', 'b2c_payments', 'b2c_refunds',
    'b2b_deal_stages', 'b2b_companies', 'b2b_deals', 'b2b_deal_stage_history',
    'b2b_bookings', 'b2b_invoices', 'b2b_receipts', 'b2b_recognised_sales'
  ] loop
    execute format(
      'create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute procedure public.write_audit_event()',
      audited_table
    );
  end loop;
end;
$$;
