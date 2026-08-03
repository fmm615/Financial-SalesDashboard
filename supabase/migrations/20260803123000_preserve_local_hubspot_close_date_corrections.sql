-- A reconciliation pull must never erase an Admin's documented local date
-- correction when HubSpot continues to return a blank close date.
create or replace function public.preserve_local_hubspot_close_date_correction()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.source_system = 'hubspot'
    and old.source_metadata ? 'local_close_date_correction_at'
    and new.hubspot_close_date is null then
    new.hubspot_close_date := old.hubspot_close_date;
    new.source_metadata := new.source_metadata || jsonb_build_object(
      'local_close_date_correction_at', old.source_metadata->'local_close_date_correction_at',
      'local_close_date_correction_by', old.source_metadata->'local_close_date_correction_by',
      'local_close_date_correction_reason', old.source_metadata->'local_close_date_correction_reason'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_local_hubspot_close_date_correction on public.b2b_deals;
create trigger preserve_local_hubspot_close_date_correction
  before update on public.b2b_deals
  for each row execute procedure public.preserve_local_hubspot_close_date_correction();
