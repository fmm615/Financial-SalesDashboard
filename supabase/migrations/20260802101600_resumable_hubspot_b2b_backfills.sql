-- Historical HubSpot imports are persistent, resumable jobs. A browser request
-- processes one bounded batch; it is never the sole owner of the full backfill.
alter table public.integration_sync_runs
  add column operation_type text not null default 'reconciliation'
    check (operation_type in ('reconciliation', 'historical_backfill')),
  add column continuation_cursor text,
  add column records_processed integer not null default 0 check (records_processed >= 0),
  add column records_failed integer not null default 0 check (records_failed >= 0);

create index integration_sync_runs_hubspot_backfill_status_idx
  on public.integration_sync_runs (provider, operation_type, status, created_at desc);
