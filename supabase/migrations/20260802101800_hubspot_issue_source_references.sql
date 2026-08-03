-- HubSpot review items must identify the affected source record. The reference
-- is deliberately small and safe for Admin UI display; raw provider payloads
-- and credentials are never stored here.
alter table public.integration_errors
  add column source_reference text;

alter table public.integration_errors
  add constraint integration_errors_source_reference_length_check
  check (source_reference is null or char_length(source_reference) between 1 and 300);

create index integration_errors_hubspot_open_source_reference_idx
  on public.integration_errors (provider, source_reference, occurred_at desc)
  where resolved_at is null;
