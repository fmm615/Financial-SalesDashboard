-- Remove only the verified development B2B fixture that was accidentally
-- present in the shared database. These IDs are reserved by supabase/seed.sql
-- and cannot match an imported HubSpot record.
delete from public.b2b_recognised_sales
where id = '14141414-1414-4414-8414-141414141414';

delete from public.b2b_bookings
where id = '13131313-1313-4313-8313-131313131313';

delete from public.b2b_deal_stage_history
where deal_id = '12121212-1212-4212-8212-121212121212';

delete from public.b2b_duplicate_group_members
where deal_id = '12121212-1212-4212-8212-121212121212';

delete from public.b2b_deals
where id = '12121212-1212-4212-8212-121212121212'
  and source_system = 'hubspot'
  and external_deal_id = 'hs_deal_001'
  and name = 'AI Noor Group Annual Agreement (fake)';

delete from public.b2b_companies
where id = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
  and source_system = 'hubspot'
  and external_company_id = 'hs_company_001'
  and legal_name = 'AI Noor Group (fake)'
  and not exists (
    select 1 from public.b2b_deals d
    where d.company_id = public.b2b_companies.id
  );
