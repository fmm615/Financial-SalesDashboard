create table public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  report_type public.report_type not null,
  period_start date not null,
  period_end date not null,
  status public.report_job_status not null default 'pending',
  requested_by uuid references public.profiles(id),
  requested_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  retry_count integer not null default 0 check (retry_count >= 0),
  delivery_requested boolean not null default false,
  safe_error_summary text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (period_end >= period_start),
  check ((status <> 'failed') or (failed_at is not null and safe_error_summary is not null)),
  check ((status <> 'completed') or completed_at is not null)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.report_jobs(id),
  generated_at timestamptz not null default timezone('utc', now()),
  summary_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.report_files (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id),
  file_kind text not null check (file_kind in ('pdf', 'csv_bundle')),
  storage_bucket text not null check (char_length(trim(storage_bucket)) > 0),
  storage_path text not null check (char_length(trim(storage_path)) > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (report_id, file_kind),
  unique (storage_bucket, storage_path)
);

create table public.report_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id),
  recipient_email citext not null,
  status public.integration_status not null default 'pending',
  requested_at timestamptz not null default timezone('utc', now()),
  sent_at timestamptz,
  failed_at timestamptz,
  safe_error_summary text,
  created_at timestamptz not null default timezone('utc', now()),
  check ((status <> 'failed') or (failed_at is not null and safe_error_summary is not null))
);

create trigger set_report_jobs_updated_at before update on public.report_jobs
  for each row execute procedure public.set_updated_at();
