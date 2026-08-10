-- Every report job has an explicit generation boundary. Financial generation is
-- reserved for a future, Finance-approved implementation and cannot be picked
-- up by the current draft worker.
alter table public.report_jobs
  add column generation_mode text not null default 'draft_fixture',
  add constraint report_jobs_generation_mode_check
    check (generation_mode in ('draft_fixture', 'financial'));

-- Archive records retain the exact snapshot contract used to make their files.
-- This makes historical artifacts explainable even after report-data adapters
-- are introduced later.
alter table public.reports
  add column snapshot_version text not null default '1',
  add column readiness_status text not null default 'draft_fixture_only',
  add constraint reports_readiness_status_check
    check (readiness_status in ('draft_fixture_only', 'financial_ready'));
