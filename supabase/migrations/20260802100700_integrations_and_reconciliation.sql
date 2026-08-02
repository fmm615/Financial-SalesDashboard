create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  status public.integration_status not null default 'pending',
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  retry_count integer not null default 0 check (retry_count >= 0),
  safe_error_summary text,
  requested_range_start timestamptz,
  requested_range_end timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (requested_range_end is null or requested_range_start is not null),
  check (requested_range_start is null or requested_range_end >= requested_range_start),
  check ((status <> 'failed') or (failed_at is not null and safe_error_summary is not null))
);

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  external_event_id text not null,
  event_type text not null,
  status public.integration_status not null default 'pending',
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  safe_metadata jsonb not null default '{}'::jsonb,
  sync_run_id uuid references public.integration_sync_runs(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (provider, external_event_id)
);

create table public.integration_errors (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  integration_event_id uuid references public.integration_events(id),
  sync_run_id uuid references public.integration_sync_runs(id),
  safe_error_summary text not null,
  occurred_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  check (resolved_at is null or resolved_by is not null)
);

create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'tap', 'hubspot')),
  lookback_start timestamptz not null,
  lookback_end timestamptz not null,
  status public.integration_status not null default 'pending',
  records_examined integer not null default 0 check (records_examined >= 0),
  records_inserted integer not null default 0 check (records_inserted >= 0),
  duplicates_detected integer not null default 0 check (duplicates_detected >= 0),
  safe_error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (lookback_end >= lookback_start),
  check (lookback_end - lookback_start <= interval '48 hours'),
  check ((status <> 'failed') or safe_error_summary is not null)
);
