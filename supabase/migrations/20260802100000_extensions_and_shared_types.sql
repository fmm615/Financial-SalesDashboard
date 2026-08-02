-- Phase 2 foundation: shared extensions, stable enums, and timestamp behaviour.
-- Monetary values use numeric rather than floating point throughout this schema.

create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.access_role as enum ('admin', 'viewer');
create type public.review_flag_type as enum (
  'refunded',
  'failed',
  'possible_duplicate',
  'unmapped_product',
  'needs_follow_up'
);
create type public.review_flag_status as enum ('open', 'resolved', 'dismissed');
create type public.backfill_status as enum ('not_started', 'partial', 'complete', 'unavailable');
create type public.integration_status as enum ('pending', 'processing', 'completed', 'failed', 'cancelled');
create type public.report_type as enum ('monthly', 'quarterly', 'annual', 'ad_hoc');
create type public.report_job_status as enum ('pending', 'processing', 'completed', 'failed', 'cancelled');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;
